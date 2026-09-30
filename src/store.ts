import { defineStore } from "pinia";
import {
  activeAssignmentOf,
  arrivalWindow,
  createEmptyLedger,
  evaluateDispatch,
  isLive,
  occupiedTons,
  orderById,
  truckById,
  uid
} from "./domain";
import { bootstrap, commit, LEDGER_STORAGE_KEY, readLedger } from "./storage";
import type {
  Assignment,
  Conflict,
  DayPhase,
  DeliveryOrder,
  FuelType,
  Ledger,
  NoticeLevel
} from "./types";

interface Notice {
  id: number;
  level: NoticeLevel;
  text: string;
}

interface DispatchState {
  ledger: Ledger;
  ready: boolean;
  booted: { recovered: number; migratedCount: number; seeded: boolean; corruptLegacy: boolean };
  notices: Notice[];
  lastChangeAt: string;
  changeSource: "本机" | "其它窗口";
}

let noticeSeq = 0;

export const useDispatchStore = defineStore("dispatch", {
  state: (): DispatchState => ({
    ledger: createEmptyLedger(new Date().toISOString()),
    ready: false,
    booted: { recovered: 0, migratedCount: 0, seeded: false, corruptLegacy: false },
    notices: [],
    lastChangeAt: "",
    changeSource: "本机"
  }),

  getters: {
    trucks: (state) => state.ledger.trucks,
    orders: (state) => state.ledger.orders,
    assignments: (state) => state.ledger.assignments,

    liveAssignments(state): Assignment[] {
      return state.ledger.assignments.filter(isLive);
    },

    /** 每辆车的实时占用：当前活跃排车吨数、是否在途 */
    truckUsage(state): (truckId: string, start: string, end: string) => { used: number; spare: number } {
      return (truckId, start, end) => {
        const truck = truckById(state.ledger, truckId);
        const used = occupiedTons(state.ledger, truckId, start, end);
        return { used, spare: Math.max(0, (truck?.capacity ?? 0) - used) };
      };
    }
  },

  actions: {
    init() {
      if (this.ready) return;
      const result = bootstrap();
      this.ledger = result.ledger;
      this.booted = {
        recovered: result.recovered.length,
        migratedCount: result.migratedCount,
        seeded: result.seeded,
        corruptLegacy: result.corruptLegacy
      };
      this.ready = true;

      if (result.recovered.length > 0) {
        this.notify("warning", `检测到上次有 ${result.recovered.length} 条未完成的调度写入，已自动恢复，占用以最新台账为准`);
      }
      if (result.migratedCount > 0) {
        this.notify("success", `旧台账迁移完成：${result.migratedCount} 张配送单已迁入新调度台账，原记录与状态保持不变（仅迁移一次）`);
      }
      if (result.corruptLegacy) {
        this.notify("error", "旧台账数据无法解析，已保留原始数据但未迁移，请联系管理员核对");
      }

      // 其它窗口提交后，本窗口只读刷新，列表/汇总/提示始终跟随最新占用
      window.addEventListener("storage", (event) => {
        if (event.key === LEDGER_STORAGE_KEY) {
          const latest = readLedger();
          if (latest) {
            this.ledger = latest;
            this.lastChangeAt = new Date().toLocaleTimeString();
            this.changeSource = "其它窗口";
          }
        }
      });
    },

    notify(level: NoticeLevel, text: string) {
      const id = ++noticeSeq;
      this.notices.push({ id, level, text });
      setTimeout(() => this.dismissNotice(id), 6000);
    },

    dismissNotice(id: number) {
      this.notices = this.notices.filter((notice) => notice.id !== id);
    },

    async createOrder(input: {
      station: string;
      fuel: FuelType;
      tons: number;
      arriveDate: string;
      phase: DayPhase;
      notes: string;
    }): Promise<boolean> {
      if (input.tons <= 0) {
        this.notify("error", "配送吨数必须大于 0");
        return false;
      }
      if (!input.arriveDate) {
        this.notify("error", "请选择计划到达日期");
        return false;
      }
      const { start, end } = arrivalWindow(input.arriveDate, input.phase);
      const order: DeliveryOrder = {
        id: uid("order"),
        station: input.station,
        fuel: input.fuel,
        tons: input.tons,
        arriveDate: input.arriveDate,
        phase: input.phase,
        windowStart: start,
        windowEnd: end,
        notes: input.notes || "暂无备注",
        status: "待发车",
        createdAt: new Date().toISOString()
      };
      this.ledger = await commit(() => ({ type: "createOrder", payload: { order } }));
      this.markLocalChange();
      this.notify("success", `配送单 ${order.station} / ${order.fuel} ${order.tons} 吨已创建，等待派车预占`);
      return true;
    },

    /**
     * 派车预占。冲突时不抢占任何资源，把冲突说明保留在草稿排车上。
     * 返回冲突列表（空数组表示预占成功）。
     */
    async reserve(input: {
      orderId: string;
      truckId: string;
      tons: number;
      assignmentId?: string;
    }): Promise<Conflict[]> {
      const order = orderById(this.ledger, input.orderId);
      if (!order) {
        this.notify("error", "配送单不存在或已被删除");
        return [{ code: "order-missing", message: "配送单不存在或已被删除" }];
      }
      const assignmentId = input.assignmentId ?? uid("asg");
      const base = {
        orderId: order.id,
        truckId: input.truckId,
        tons: input.tons,
        windowStart: order.windowStart,
        windowEnd: order.windowEnd
      };
      this.ledger = await commit(
        () => ({
          type: "reserve",
          payload: { assignmentId, ...base }
        }),
        {
          // 锁内基于最新占用二次校验：另一窗口刚提交的排车在这里可见
          prepare(latest) {
            const conflicts = evaluateDispatch(latest, base, assignmentId);
            return { conflicts: conflicts.map((c) => c.code), conflictMessages: conflicts.map((c) => c.message) };
          }
        }
      );
      this.markLocalChange();
      // 以发布后的最新台账重新算一遍用于提示（保证 UI 展示与存储层一致）
      const conflicts = evaluateDispatch(this.ledger, base, assignmentId);
      if (conflicts.length > 0) {
        this.notify(
          "warning",
          `派车未通过，已保留草稿：${conflicts.map((c) => c.message).join("；")}`
        );
      } else {
        const truck = truckById(this.ledger, input.truckId);
        this.notify("success", `已按计划到达时段预占 ${truck?.name ?? "车辆"} 罐容 ${input.tons} 吨，装车后请确认占用`);
      }
      return conflicts;
    },

    /** 装车完成：预占 → 正式占用，配送单进入运输中 */
    async confirmLoad(assignmentId: string) {
      const assignment = this.ledger.assignments.find((a) => a.id === assignmentId);
      if (!assignment || assignment.phase !== "reserved") {
        this.notify("error", "只有已预占的排车才能确认装车");
        return;
      }
      this.ledger = await commit(() => ({ type: "confirmLoad", payload: { assignmentId } }));
      this.markLocalChange();
      this.notify("success", "装车确认完成，车辆与罐容已转为正式占用，配送单进入运输中");
    },

    /** 到站交付：占用释放，排车完成（迁移来的无排车在途单也可直接流转） */
    async confirmArrival(assignmentId?: string, orderId?: string) {
      const assignment = assignmentId ? this.ledger.assignments.find((a) => a.id === assignmentId) : undefined;
      if (assignment && assignment.phase !== "occupied") {
        this.notify("error", "只有在途（已占用）的排车才能确认到站");
        return;
      }
      if (!assignment && orderId) {
        const order = orderById(this.ledger, orderId);
        if (order?.status !== "运输中") {
          this.notify("error", "只有运输中的配送单才能确认到站");
          return;
        }
      }
      this.ledger = await commit(() => ({ type: "confirmArrival", payload: { assignmentId, orderId } }));
      this.markLocalChange();
      this.notify("success", "到站确认完成，车辆与罐容已释放，排车闭环");
    },

    /** 撤单：释放当前排车占用 */
    async cancelOrder(orderId: string) {
      const order = orderById(this.ledger, orderId);
      if (!order) return;
      if (order.status === "已到站" || order.status === "已撤单" || order.status === "异常") {
        this.notify("warning", "该配送单已结束，不能撤单");
        return;
      }
      this.ledger = await commit(() => ({ type: "cancelOrder", payload: { orderId } }));
      this.markLocalChange();
      this.notify("info", `${order.station} 的配送单已撤单，车辆与罐容占用已释放`);
    },

    /** 在途失败：释放占用，配送单标记异常 */
    async failInTransit(orderId: string) {
      const order = orderById(this.ledger, orderId);
      if (!order) return;
      if (order.status !== "运输中") {
        this.notify("warning", "只有运输中的配送单才能登记在途失败");
        return;
      }
      this.ledger = await commit(() => ({ type: "failInTransit", payload: { orderId } }));
      this.markLocalChange();
      this.notify("warning", `${order.station} 的配送单在途失败，占用已释放，配送单标记为异常`);
    },

    /** 主动释放预占（未装车时换车/取消派车） */
    async releaseAssignment(assignmentId: string) {
      const assignment = this.ledger.assignments.find((a) => a.id === assignmentId);
      if (!assignment || !isLive(assignment)) {
        this.notify("error", "该排车没有可释放的占用");
        return;
      }
      this.ledger = await commit(() => ({ type: "releaseAssignment", payload: { assignmentId } }));
      this.markLocalChange();
      this.notify("info", "预占已释放，车辆罐容恢复可用");
    },

    /** 删除草稿（冲突无法解决时放弃该排车方案） */
    async deleteAssignment(assignmentId: string) {
      const assignment = this.ledger.assignments.find((a) => a.id === assignmentId);
      if (!assignment) return;
      if (isLive(assignment)) {
        this.notify("error", "占用中的排车不能直接删除，请先释放");
        return;
      }
      this.ledger = await commit(() => ({ type: "deleteAssignment", payload: { assignmentId } }));
      this.markLocalChange();
      this.notify("info", "草稿已删除");
    },

    /** 删除终态配送单（撤单/异常/到站），排车历史保留留痕 */
    async deleteOrder(orderId: string) {
      const order = orderById(this.ledger, orderId);
      if (!order) return;
      const active = activeAssignmentOf(this.ledger, orderId);
      if (active && isLive(active)) {
        this.notify("warning", "该配送单仍占用车辆，请先撤单或释放排车后再删除");
        return;
      }
      this.ledger = await commit(() => ({ type: "deleteOrder", payload: { orderId } }));
      this.markLocalChange();
      this.notify("info", `配送单 ${order.station} 已删除，排车历史保留在台账中`);
    },

    markLocalChange() {
      this.lastChangeAt = new Date().toLocaleTimeString();
      this.changeSource = "本机";
    }
  }
});
