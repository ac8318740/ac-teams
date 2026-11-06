import { visibleWidth } from "@earendil-works/pi-tui";
import type { Bounds, TaskGraph } from "./graph.ts";
import type { TaskView } from "../types.ts";

const wireGlyphs = ["", "│", "│", "│", "─", "┘", "┐", "┤", "─", "└", "┌", "├", "─", "┴", "┬", "┼"];
type TrackSpan = [start: number, end: number, from: number, to: number, edge: number];

function assignTracks(spans: TrackSpan[]): Map<number, number> {
  const tracks: TrackSpan[][] = [], assigned = new Map<number, number>();
  spans.sort((a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  for (const span of spans) {
    let slot = tracks.findIndex(row => row.every(other => other[1] + 2 <= span[0] || span[1] + 2 <= other[0] || other[2] === span[2] || other[3] === span[3]));
    if (slot < 0) { slot = tracks.length; tracks.push([]); }
    tracks[slot].push(span);
    assigned.set(span[4], slot);
  }
  return assigned;
}

// shortcut: reconstruct only grok-mermaid 0.2.3's generated TD routes; validate the
// visible grid and endpoints so renderer changes disable jumps instead of guessing.
function crossingCells(tasks: TaskView[], graph: TaskGraph): { jumps: Set<number>; masks: Uint8Array; actual: Map<number, string> } | null {
  const { art, bounds } = graph;
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 100 || !(bounds instanceof Map) || bounds.size !== tasks.length
    || !art || !Number.isSafeInteger(art.width) || art.width < 1 || art.width > 2000
    || !Array.isArray(art.plain) || !Array.isArray(art.styled) || !art.plain.length || art.plain.length > 2000
    || art.plain.length !== art.styled.length || art.width * art.plain.length > 2_000_000
    || !Array.isArray(art.warnings) || art.warnings.length) return null;
  const width = art.width, height = art.plain.length, index = new Map<string, number>(), numbers = new Set<number>();
  let edgeCount = 0, textSize = 0;
  for (const [i, task] of tasks.entries()) {
    if (!task || typeof task.id !== "string" || !task.id.length || task.id.length > 128 || index.has(task.id)
      || !Number.isSafeInteger(task.number) || task.number < 1 || numbers.has(task.number) || !Array.isArray(task.dependencies)
      || (edgeCount += task.dependencies.length) > 300 || task.dependencies.some(id => typeof id !== "string" || id.length > 128)
      || new Set(task.dependencies).size !== task.dependencies.length) return null;
    // Labeled completion edges use different routes; preserve the renderer's original art.
    if (!Array.isArray(task.completionDependencies) || task.completionDependencies.length) return null;
    index.set(task.id, i); numbers.add(task.number);
  }
  const edges: { from: number; to: number }[] = [];
  for (const [to, task] of tasks.entries()) for (const id of task.dependencies) {
    const from = index.get(id);
    if (from === undefined) return null;
    edges.push({ from, to });
  }
  const ranks: number[] = [], visiting = new Set<number>();
  const rank = (i: number): number => {
    if (ranks[i] !== undefined) return ranks[i];
    if (visiting.has(i)) return -1;
    visiting.add(i);
    let result = 0;
    for (const id of tasks[i].dependencies) {
      const parent = rank(index.get(id)!);
      if (parent < 0) return -1;
      result = Math.max(result, parent + 1);
    }
    visiting.delete(i);
    return ranks[i] = result;
  };
  for (let i = 0; i < tasks.length; i++) if (rank(i) < 0) return null;

  const boxes: Bounds[] = [], occupied = new Uint8Array(width * height);
  for (const task of tasks) {
    const box = bounds.get(task.id);
    if (!box || ![box.left, box.right, box.top, box.bottom].every(Number.isSafeInteger)
      || box.left < 0 || box.top < 0 || box.right >= width || box.bottom >= height || box.right - box.left < 2 || box.bottom - box.top < 2) return null;
    for (let y = box.top; y <= box.bottom; y++) {
      const start = y * width + box.left, end = y * width + box.right + 1;
      if (occupied.subarray(start, end).some(Boolean)) return null;
      occupied.fill(1, start, end);
    }
    boxes.push(box);
  }
  const actual = new Map<number, string>(), borders = new Map<number, string>();
  for (let y = 0; y < height; y++) {
    const row = art.styled[y], plain = art.plain[y];
    if (!Array.isArray(row) || row.length > width || typeof plain !== "string" || (textSize += plain.length) > 4_000_000) return null;
    // Check lengths before width measurement or joining potentially hostile strings.
    for (const span of row) if (!span || typeof span.text !== "string" || !["none", "text", "border", "edge"].includes(span.cls)
      || (textSize += span.text.length) > 4_000_000) return null;
    if (row.map(span => span.text).join("").replace(/ +$/, "") !== plain) return null;
    let x = 0;
    for (const span of row) {
      if (span.cls === "edge" || span.cls === "border") {
        for (const ch of span.text) {
          if (x >= width) return null;
          const key = y * width + x++;
          if (span.cls === "edge") {
            if (occupied[key] || (!wireGlyphs.includes(ch) && ch !== "▼" && ch !== "◄")) return null;
            actual.set(key, ch);
          } else {
            if (!occupied[key] || !wireGlyphs.includes(ch)) return null;
            borders.set(key, ch);
          }
        }
      } else x += visibleWidth(span.text);
      if (x > width) return null;
    }
  }
  // Bounds must describe the actual rectangular boxes, not just free coordinates.
  for (const box of boxes) {
    for (const [x, y, glyph] of [[box.left, box.top, "┌"], [box.right, box.top, "┐"], [box.left, box.bottom, "└"], [box.right, box.bottom, "┘"]] as const) {
      if (borders.get(y * width + x) !== glyph) return null;
    }
  }

  const cx = (box: Bounds) => box.left + Math.floor((box.right - box.left + 1) / 2);
  const cy = (box: Bounds) => box.top + Math.floor((box.bottom - box.top + 1) / 2);
  const span = (a: number, b: number, from: number, to: number, edge: number): TrackSpan => [Math.min(a, b), Math.max(a, b), from, to, edge];
  const buses = new Map<number, number>(), bandEnds: number[] = [];
  for (let r = 0; r <= Math.max(...ranks); r++) {
    bandEnds[r] = Math.max(...boxes.filter((_, i) => ranks[i] === r).map(box => box.bottom)) + 1;
    const spans = edges.flatMap(({ from, to }, i) => ranks[from] === r && ranks[to] === r + 1 && Math.abs(cx(boxes[from]) - cx(boxes[to])) > 1
      ? [span(cx(boxes[from]), cx(boxes[to]), from, to, i)] : []);
    for (const [i, slot] of assignTracks(spans)) buses.set(i, slot);
  }
  const laneBase = Math.max(...boxes.map(box => box.right)) + 2;
  const lanes = assignTracks(edges.flatMap(({ from, to }, i) => ranks[to] !== ranks[from] + 1 ? [span(cy(boxes[from]), cy(boxes[to]), from, to, i)] : []));
  const expected = new Uint8Array(width * height), heads = new Map<number, string>(), exits = new Map<number, number>();
  const owners = new Map<number, Map<number, number>>();
  let work = 0;
  const add = (x: number, y: number, bits: number, edge: number): boolean => {
    if (++work > 1_000_000 || x < 0 || x >= width || y < 0 || y >= height) return false;
    const key = y * width + x;
    if (!bits || occupied[key]) return true;
    if (!actual.has(key)) return false;
    expected[key] |= bits;
    if (actual.get(key) === "┼") {
      let cell = owners.get(key);
      if (!cell) { cell = new Map(); owners.set(key, cell); }
      cell.set(edge, (cell.get(edge) ?? 0) | bits);
    }
    return true;
  };
  const segment = (a: number[], b: number[], edge: number): boolean => {
    if (a[0] === b[0]) {
      const low = Math.min(a[1], b[1]), high = Math.max(a[1], b[1]);
      for (let y = low; y <= high; y++) if (!add(a[0], y, (y > low ? 1 : 0) | (y < high ? 2 : 0), edge)) return false;
    } else {
      if (a[1] !== b[1]) return false;
      const low = Math.min(a[0], b[0]), high = Math.max(a[0], b[0]);
      for (let x = low; x <= high; x++) if (!add(x, a[1], (x > low ? 4 : 0) | (x < high ? 8 : 0), edge)) return false;
    }
    return true;
  };
  for (const [i, { from, to }] of edges.entries()) {
    const a = boxes[from], b = boxes[to];
    let points: number[][], head: string, exitBits: number;
    if (ranks[to] === ranks[from] + 1) {
      const tx = cx(b), bx = Math.abs(cx(a) - tx) <= 1 ? tx : cx(a), bus = bandEnds[ranks[from]] + (buses.get(i) ?? 0);
      if (bx <= a.left || bx >= a.right || bus >= b.top) return null;
      points = [[bx, a.bottom], [bx, bus], [tx, bus], [tx, b.top - 1]];
      head = "▼"; exitBits = 2;
    } else {
      const lane = laneBase + lanes.get(i)!;
      points = [[a.right, cy(a)], [lane, cy(a)], [lane, cy(b)], [b.right + 1, cy(b)]];
      head = "◄"; exitBits = 8;
    }
    const start = points[0], end = points[points.length - 1], headKey = end[1] * width + end[0], exitKey = start[1] * width + start[0];
    if (actual.get(headKey) !== head || (heads.has(headKey) && heads.get(headKey) !== head)) return null;
    heads.set(headKey, head);
    exits.set(exitKey, (exits.get(exitKey) ?? 0) | exitBits);
    for (let j = 1; j < points.length; j++) if (!segment(points[j - 1], points[j], i)) return null;
  }
  for (const [key, bits] of exits) if (borders.get(key) !== wireGlyphs[bits | (bits & 2 ? 12 : 3)]) return null;
  for (const [key, ch] of actual) if (ch !== (heads.get(key) ?? wireGlyphs[expected[key]])) return null;

  const jumps = new Set<number>();
  for (const [key, cell] of owners) {
    const horizontal: number[] = [], vertical: number[] = [];
    let straight = true;
    for (const [edge, mask] of cell) {
      if (mask === 12) horizontal.push(edge);
      else if (mask === 3) vertical.push(edge);
      else { straight = false; break; }
    }
    if (straight && horizontal.length && vertical.length && horizontal.every(h => vertical.every(v => edges[h].from !== edges[v].from && edges[h].to !== edges[v].to
      && edges[h].from !== edges[v].to && edges[h].to !== edges[v].from))) jumps.add(key);
  }
  return { jumps, masks: expected, actual };
}

/** Add connected rounded bridges, inserting a wire-only spacer row where needed. */
export function addGraphJumps(tasks: TaskView[], graph: TaskGraph): TaskGraph & { jumps: number | null } {
  const verified = crossingCells(tasks, graph);
  if (!verified?.jumps.size) return { ...graph, jumps: verified === null ? null : 0 };
  const { art } = graph, { masks, actual } = verified;
  const bridges = new Map<number, number[]>();
  let count = 0;
  for (const key of [...verified.jumps].sort((a, b) => a - b)) {
    const y = Math.floor(key / art.width), x = key % art.width;
    // Never split a box, detach an incoming arrow, or overwrite another vertical wire.
    if (!y || x < 1 || x + 1 >= art.width || [...graph.bounds.values()].some(box => box.top <= y && box.bottom >= y)
      || actual.get(key - 1) !== "─" || actual.get(key + 1) !== "─"
      || masks[key - 1] & 1 || masks[key + 1] & 1) continue;
    const row = bridges.get(y) ?? [];
    if (row.some(other => Math.abs(other - x) <= 2)) continue;
    const rows = art.plain.length + bridges.size + Number(!bridges.has(y));
    if (rows > 2000 || art.width * rows > 2_000_000) continue;
    row.push(x); bridges.set(y, row); count++;
  }
  if (!count) return { ...graph, jumps: 0 };
  const styled: typeof art.styled = [], positions: number[] = [];
  for (const [y, row] of art.styled.entries()) {
    const centers = bridges.get(y), patches = new Map<number, string>();
    if (centers) {
      const top = new Map<number, string>();
      for (const x of centers) {
        top.set(x - 1, "╭"); top.set(x, "─"); top.set(x + 1, "╮");
        patches.set(x - 1, "╯"); patches.set(x, "│"); patches.set(x + 1, "╰");
      }
      const gap: typeof row = [];
      for (let x = 0; x < art.width; x++) {
        const text = top.get(x) ?? (masks[y * art.width + x] & 1 ? "│" : " ");
        const cls = text === " " ? "none" : "edge", last = gap[gap.length - 1];
        if (last?.cls === cls) last.text += text;
        else gap.push({ text, cls });
      }
      styled.push(gap);
    }
    positions[y] = styled.length;
    let x = 0;
    styled.push(!centers ? row : row.map(span => {
      if (span.cls !== "edge") { x += visibleWidth(span.text); return span; }
      let text = "";
      for (const ch of span.text) text += patches.get(x++) ?? ch;
      return text === span.text ? span : { ...span, text };
    }));
  }
  const plain = styled.map(row => row.map(span => span.text).join("").trimEnd());
  const bounds = new Map([...graph.bounds].map(([id, box]) => [id, { ...box, top: positions[box.top], bottom: positions[box.bottom] }]));
  return { ...graph, art: { ...art, plain, styled }, bounds, jumps: count };
}
