import { estimateTravel, LatLng, TravelMode, UNKNOWN_LEG_MINUTES } from './travel';

export interface SolverItem {
  id: string;
  title: string;
  dwellMinutes: number;
  location?: LatLng;
  fixedStartMinutes?: number; // Minutes from 00:00
  windowStartMinutes?: number;
  windowEndMinutes?: number;
  openingHours?: { openMinutes: number; closeMinutes: number }[];
}

export interface SolverConstraint {
  id: string;
  type: 'MUST_BE_BEFORE' | 'MUST_BE_AFTER' | 'FIXED_POSITION';
  sourceItemId: string;
  targetItemId: string;
  isHard: boolean;
}

export interface SolverInput {
  dayId: string;
  dayStartMinutes: number; // e.g. 540 = 09:00
  dayPreferredEndMinutes?: number; // e.g. 1260 = 21:00
  startLocation?: LatLng;
  travelMode?: TravelMode;
  items: SolverItem[];
  constraints: SolverConstraint[];
  /** Optional explicit travel minutes; when absent, travel is estimated from coordinates. */
  travelMatrixMinutes?: Record<string, Record<string, number>>;
}

export interface ScheduledLeg {
  fromId: string;
  toId: string;
  travelMinutes: number;
  distanceMeters: number;
  mode: TravelMode;
}

export interface ScheduledItem {
  id: string;
  plannedStartMinutes: number;
  plannedEndMinutes: number;
  dwellMinutes: number;
  plannedStartFormatted: string;
  plannedEndFormatted: string;
}

export interface SolverResult {
  success: boolean;
  orderedItemIds: string[];
  schedule: ScheduledItem[];
  legs: ScheduledLeg[];
  travelMinutesBefore: number;
  travelMinutesAfter: number;
  /** True when the current order was already the best one found. */
  unchanged: boolean;
  warnings: string[];
  error?: string;
}

interface Simulation {
  order: SolverItem[];
  schedule: ScheduledItem[];
  legs: ScheduledLeg[];
  travelMinutes: number;
  endMinutes: number;
  score: number;
  warnings: string[];
}

export const START_NODE_ID = 'start';

/** Orders up to this many stops by exhaustive search (with pruning); larger days use a heuristic. */
const EXACT_SEARCH_LIMIT = 9;

// Score weights: minutes of travel are the baseline unit; broken commitments cost far more.
const LATENESS_WEIGHT = 4;
const CLOSED_PENALTY = 90;
const OVERRUN_WEIGHT = 1;
const WAIT_WEIGHT = 0.05;

export function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = Math.round(mins) % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export class ItinerarySolver {
  solve(input: SolverInput): SolverResult {
    const predecessors = this.buildPredecessors(input);
    if (this.hasCycle(input.items, predecessors)) {
      return {
        success: false,
        orderedItemIds: [],
        schedule: [],
        legs: [],
        travelMinutesBefore: 0,
        travelMinutesAfter: 0,
        unchanged: true,
        warnings: [],
        error: 'Cyclic constraint detected. Check that your "Keep before" and "Keep after" rules do not form a loop.'
      };
    }

    const baseline = this.simulate(input.items, input);
    const searched = input.items.length <= EXACT_SEARCH_LIMIT
      ? this.exhaustiveSearch(input, predecessors)
      : this.greedySearch(input, predecessors);

    // Never propose a change that isn't actually better than a valid current plan.
    const baselineIsValid = this.respectsPrecedence(input.items, predecessors);
    const best = baselineIsValid && baseline.score <= searched.score + 0.01 ? baseline : searched;

    return {
      success: true,
      orderedItemIds: best.order.map(i => i.id),
      schedule: best.schedule,
      legs: best.legs,
      travelMinutesBefore: baseline.travelMinutes,
      travelMinutesAfter: best.travelMinutes,
      unchanged: best === baseline,
      warnings: best.warnings
    };
  }

  private buildPredecessors(input: SolverInput): Map<string, Set<string>> {
    const ids = new Set(input.items.map(i => i.id));
    const predecessors = new Map<string, Set<string>>(input.items.map(i => [i.id, new Set<string>()]));
    for (const c of input.constraints) {
      if (!c.isHard || c.type === 'FIXED_POSITION') continue;
      const [before, after] = c.type === 'MUST_BE_AFTER'
        ? [c.targetItemId, c.sourceItemId]
        : [c.sourceItemId, c.targetItemId];
      if (ids.has(before) && ids.has(after)) predecessors.get(after)!.add(before);
    }
    return predecessors;
  }

  /** Kahn's algorithm: a cycle exists when not every node can be removed. */
  private hasCycle(items: SolverItem[], predecessors: Map<string, Set<string>>): boolean {
    const remaining = new Map(items.map(i => [i.id, new Set(predecessors.get(i.id))]));
    let progressed = true;
    while (remaining.size > 0 && progressed) {
      progressed = false;
      for (const [id, preds] of remaining) {
        if (preds.size === 0) {
          remaining.delete(id);
          remaining.forEach(p => p.delete(id));
          progressed = true;
        }
      }
    }
    return remaining.size > 0;
  }

  private respectsPrecedence(order: SolverItem[], predecessors: Map<string, Set<string>>): boolean {
    const seen = new Set<string>();
    for (const item of order) {
      for (const p of predecessors.get(item.id) ?? []) if (!seen.has(p)) return false;
      seen.add(item.id);
    }
    return true;
  }

  private exhaustiveSearch(input: SolverInput, predecessors: Map<string, Set<string>>): Simulation {
    let best: Simulation | null = null;
    const prefix: SolverItem[] = [];
    const used = new Set<string>();

    const visit = () => {
      if (prefix.length === input.items.length) {
        const sim = this.simulate(prefix, input);
        if (!best || sim.score < best.score) best = sim;
        return;
      }
      for (const item of input.items) {
        if (used.has(item.id)) continue;
        if ([...(predecessors.get(item.id) ?? [])].some(p => !used.has(p))) continue;
        prefix.push(item);
        used.add(item.id);
        // Every score term only grows as stops are appended, so a partial score is a lower bound.
        if (!best || this.simulate(prefix, input).score < best.score) visit();
        prefix.pop();
        used.delete(item.id);
      }
    };
    visit();
    return best ?? this.simulate(input.items, input);
  }

  /** Nearest-feasible-next construction, then adjacent swaps while they improve the score. */
  private greedySearch(input: SolverInput, predecessors: Map<string, Set<string>>): Simulation {
    const order: SolverItem[] = [];
    const used = new Set<string>();
    while (order.length < input.items.length) {
      let bestNext: { item: SolverItem; score: number } | null = null;
      for (const item of input.items) {
        if (used.has(item.id)) continue;
        if ([...(predecessors.get(item.id) ?? [])].some(p => !used.has(p))) continue;
        const score = this.simulate([...order, item], input).score;
        if (!bestNext || score < bestNext.score) bestNext = { item, score };
      }
      if (!bestNext) break; // unreachable: cycles are rejected earlier
      order.push(bestNext.item);
      used.add(bestNext.item.id);
    }

    let current = this.simulate(order, input);
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) {
        const candidate = [...current.order];
        [candidate[i], candidate[i + 1]] = [candidate[i + 1], candidate[i]];
        if (!this.respectsPrecedence(candidate, predecessors)) continue;
        const sim = this.simulate(candidate, input);
        if (sim.score < current.score - 0.01) {
          current = sim;
          improved = true;
        }
      }
    }
    return current;
  }

  private leg(from: SolverItem | null, to: SolverItem, input: SolverInput): ScheduledLeg | null {
    const mode = input.travelMode ?? 'WALK';
    if (from === null) {
      if (!input.startLocation || !to.location) return null;
      const est = estimateTravel(input.startLocation, to.location, mode);
      return { fromId: START_NODE_ID, toId: to.id, travelMinutes: est.minutes, distanceMeters: est.meters, mode: est.mode };
    }
    const explicit = input.travelMatrixMinutes?.[from.id]?.[to.id];
    if (explicit !== undefined) {
      return { fromId: from.id, toId: to.id, travelMinutes: explicit, distanceMeters: explicit * 80, mode };
    }
    if (from.location && to.location) {
      const est = estimateTravel(from.location, to.location, mode);
      return { fromId: from.id, toId: to.id, travelMinutes: est.minutes, distanceMeters: est.meters, mode: est.mode };
    }
    return { fromId: from.id, toId: to.id, travelMinutes: UNKNOWN_LEG_MINUTES, distanceMeters: 0, mode };
  }

  private simulate(order: SolverItem[], input: SolverInput): Simulation {
    const schedule: ScheduledItem[] = [];
    const legs: ScheduledLeg[] = [];
    const warnings: string[] = [];
    let time = input.dayStartMinutes;
    let travel = 0;
    let lateness = 0;
    let closed = 0;
    let wait = 0;
    let previous: SolverItem | null = null;

    for (const item of order) {
      const leg = this.leg(previous, item, input);
      if (leg) {
        time += leg.travelMinutes;
        travel += leg.travelMinutes;
        legs.push(leg);
      }

      let start = time;
      if (item.fixedStartMinutes !== undefined) {
        if (time > item.fixedStartMinutes) {
          lateness += time - item.fixedStartMinutes;
          warnings.push(`You'd reach "${item.title}" at ${formatMinutes(time)}, after its fixed ${formatMinutes(item.fixedStartMinutes)} start.`);
        } else {
          wait += item.fixedStartMinutes - time;
          start = item.fixedStartMinutes;
        }
      } else if (item.windowStartMinutes !== undefined && time < item.windowStartMinutes) {
        wait += item.windowStartMinutes - time;
        start = item.windowStartMinutes;
      }

      const end = start + item.dwellMinutes;
      if (item.windowEndMinutes !== undefined && end > item.windowEndMinutes) {
        lateness += end - item.windowEndMinutes;
        warnings.push(`"${item.title}" runs past its ${formatMinutes(item.windowEndMinutes)} window.`);
      }
      if (item.openingHours && item.openingHours.length > 0) {
        const open = item.openingHours.some(oh => start >= oh.openMinutes && end <= oh.closeMinutes);
        if (!open) {
          closed++;
          warnings.push(`"${item.title}" looks closed at the planned time (${formatMinutes(start)}–${formatMinutes(end)}).`);
        }
      }

      schedule.push({
        id: item.id,
        plannedStartMinutes: start,
        plannedEndMinutes: end,
        dwellMinutes: item.dwellMinutes,
        plannedStartFormatted: formatMinutes(start),
        plannedEndFormatted: formatMinutes(end)
      });
      time = end;
      previous = item;
    }

    const overrun = input.dayPreferredEndMinutes !== undefined ? Math.max(0, time - input.dayPreferredEndMinutes) : 0;
    if (overrun > 0 && input.dayPreferredEndMinutes !== undefined) {
      warnings.push(`The day would end at ${formatMinutes(time)}, after your preferred ${formatMinutes(input.dayPreferredEndMinutes)}.`);
    }

    return {
      order: [...order],
      schedule,
      legs,
      travelMinutes: travel,
      endMinutes: time,
      score: travel + LATENESS_WEIGHT * lateness + CLOSED_PENALTY * closed + OVERRUN_WEIGHT * overrun + WAIT_WEIGHT * wait,
      warnings
    };
  }
}
