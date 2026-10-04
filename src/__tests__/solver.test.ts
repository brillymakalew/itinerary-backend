import { ItinerarySolver, SolverInput } from '../itinerary/solver';

describe('ItinerarySolver (PRD §31.2 Test Cases)', () => {
  let solver: ItinerarySolver;

  beforeEach(() => {
    solver = new ItinerarySolver();
  });

  test('Case 1: A, B, C with no constraints orders cleanly', () => {
    const input: SolverInput = {
      dayId: 'day_1',
      dayStartMinutes: 540, // 09:00
      items: [
        { id: 'A', title: 'Coffee', dwellMinutes: 45 },
        { id: 'B', title: 'Museum', dwellMinutes: 60 },
        { id: 'C', title: 'Lunch', dwellMinutes: 60 },
      ],
      constraints: [],
      travelMatrixMinutes: {
        A: { B: 10, C: 20 },
        B: { C: 15 },
      },
    };

    const res = solver.solve(input);
    expect(res.success).toBe(true);
    expect(res.orderedItemIds.length).toBe(3);
    expect(res.schedule[0].plannedStartFormatted).toBe('09:00');
  });

  test('Case 2: B must be before A constraint is honored', () => {
    const input: SolverInput = {
      dayId: 'day_1',
      dayStartMinutes: 540,
      items: [
        { id: 'A', title: 'Cafe', dwellMinutes: 45 },
        { id: 'B', title: 'Breakfast', dwellMinutes: 45 },
      ],
      constraints: [
        { id: 'c1', type: 'MUST_BE_BEFORE', sourceItemId: 'B', targetItemId: 'A', isHard: true },
      ],
      travelMatrixMinutes: {},
    };

    const res = solver.solve(input);
    expect(res.success).toBe(true);
    expect(res.orderedItemIds).toEqual(['B', 'A']);
  });

  test('Case 3: Cycle A before B and B before A yields clear error', () => {
    const input: SolverInput = {
      dayId: 'day_1',
      dayStartMinutes: 540,
      items: [
        { id: 'A', title: 'Cafe A', dwellMinutes: 30 },
        { id: 'B', title: 'Cafe B', dwellMinutes: 30 },
      ],
      constraints: [
        { id: 'c1', type: 'MUST_BE_BEFORE', sourceItemId: 'A', targetItemId: 'B', isHard: true },
        { id: 'c2', type: 'MUST_BE_BEFORE', sourceItemId: 'B', targetItemId: 'A', isHard: true },
      ],
      travelMatrixMinutes: {},
    };

    const res = solver.solve(input);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Cyclic constraint detected');
  });

  test('Case 4: Place closes before calculated arrival flags warning', () => {
    const input: SolverInput = {
      dayId: 'day_1',
      dayStartMinutes: 1080, // 18:00
      items: [
        {
          id: 'A',
          title: 'Early Museum',
          dwellMinutes: 60,
          openingHours: [{ openMinutes: 480, closeMinutes: 1020 }], // 08:00 - 17:00
        },
      ],
      constraints: [],
      travelMatrixMinutes: {},
    };

    const res = solver.solve(input);
    expect(res.success).toBe(true);
    expect(res.warnings.length).toBeGreaterThan(0);
    expect(res.warnings[0]).toContain('closed');
  });

  // Hanoi Old Quarter coordinates used by the demo trip.
  const hotel = { latitude: 21.0322, longitude: 105.8531 };
  const cafeGiang = { latitude: 21.0336, longitude: 105.8542 };
  const trainStreet = { latitude: 21.0298, longitude: 105.8427 };
  const bunCha = { latitude: 21.0186, longitude: 105.8529 };

  test('Case 5: reorders stops to cut travel and reports an honest before/after', () => {
    const res = solver.solve({
      dayId: 'day_2',
      dayStartMinutes: 540,
      startLocation: hotel,
      items: [
        { id: 'bunCha', title: 'Bún chả', dwellMinutes: 60, location: bunCha },
        { id: 'giang', title: 'Café Giảng', dwellMinutes: 50, location: cafeGiang },
        { id: 'train', title: 'Train Street', dwellMinutes: 45, location: trainStreet },
      ],
      constraints: [],
    });
    expect(res.success).toBe(true);
    expect(res.unchanged).toBe(false);
    expect(res.orderedItemIds[0]).toBe('giang'); // closest to the hotel
    expect(res.travelMinutesAfter).toBeLessThan(res.travelMinutesBefore);
    expect(res.legs.every(l => l.travelMinutes > 0)).toBe(true);
  });

  test('Case 6: a lunch window is respected even when it costs a little travel', () => {
    const res = solver.solve({
      dayId: 'day_2',
      dayStartMinutes: 540,
      startLocation: hotel,
      items: [
        { id: 'giang', title: 'Café Giảng', dwellMinutes: 50, location: cafeGiang },
        { id: 'bunCha', title: 'Bún chả', dwellMinutes: 60, location: bunCha, windowStartMinutes: 690, windowEndMinutes: 810 },
        { id: 'train', title: 'Train Street', dwellMinutes: 45, location: trainStreet },
      ],
      constraints: [{ id: 'c1', type: 'MUST_BE_BEFORE', sourceItemId: 'giang', targetItemId: 'bunCha', isHard: true }],
    });
    const lunch = res.schedule.find(s => s.id === 'bunCha')!;
    expect(lunch.plannedStartMinutes).toBeGreaterThanOrEqual(690);
    expect(lunch.plannedEndMinutes).toBeLessThanOrEqual(810);
    expect(res.orderedItemIds.indexOf('giang')).toBeLessThan(res.orderedItemIds.indexOf('bunCha'));
    expect(res.warnings).toEqual([]);
  });

  test('Case 7: re-optimizing an optimized day changes nothing', () => {
    const items = [
      { id: 'train', title: 'Train Street', dwellMinutes: 45, location: trainStreet },
      { id: 'bunCha', title: 'Bún chả', dwellMinutes: 60, location: bunCha },
      { id: 'giang', title: 'Café Giảng', dwellMinutes: 50, location: cafeGiang },
    ];
    const input = { dayId: 'day_2', dayStartMinutes: 540, startLocation: hotel, constraints: [] };
    const first = solver.solve({ ...input, items });
    const optimizedOrder = first.orderedItemIds.map(id => items.find(i => i.id === id)!);
    const second = solver.solve({ ...input, items: optimizedOrder });
    expect(second.unchanged).toBe(true);
    expect(second.travelMinutesAfter).toBe(second.travelMinutesBefore);
    expect(second.orderedItemIds).toEqual(first.orderedItemIds);
  });

  test('Case 8: fixed-time stops anchor the schedule', () => {
    const res = solver.solve({
      dayId: 'day_1',
      dayStartMinutes: 1080,
      items: [
        { id: 'market', title: 'Night market', dwellMinutes: 120, location: cafeGiang },
        { id: 'checkin', title: 'Hotel check-in', dwellMinutes: 30, location: hotel, fixedStartMinutes: 1155 },
        { id: 'airport', title: 'Airport transfer', dwellMinutes: 45, fixedStartMinutes: 1080 },
      ],
      constraints: [],
    });
    expect(res.orderedItemIds).toEqual(['airport', 'checkin', 'market']);
    expect(res.schedule[1].plannedStartFormatted).toBe('19:15');
  });
});

