function area(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTriangle(point, a, b, c) {
  const ab = area(a, b, point);
  const bc = area(b, c, point);
  const ca = area(c, a, point);
  return ab >= -1e-8 && bc >= -1e-8 && ca >= -1e-8;
}

function clipValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clipRingEdge(input, inside, intersect) {
  if (input.length === 0) return [];
  const output = [];
  let previous = input.at(-1);
  for (const current of input) {
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside !== previousInside) output.push(intersect(previous, current));
    if (currentInside) output.push(current);
    previous = current;
  }
  return output;
}

export function clipRingToBbox(ring, bbox) {
  const points = ring.map((point) => [point[1], point[2]]);
  if (points.length > 1 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
  const edges = [
    [(point) => point[0] >= bbox.west, (a, b) => [bbox.west, a[1] + (b[1] - a[1]) * ((bbox.west - a[0]) / (b[0] - a[0] || 1e-12))]],
    [(point) => point[0] <= bbox.east, (a, b) => [bbox.east, a[1] + (b[1] - a[1]) * ((bbox.east - a[0]) / (b[0] - a[0] || 1e-12))]],
    [(point) => point[1] >= bbox.south, (a, b) => [a[0] + (b[0] - a[0]) * ((bbox.south - a[1]) / (b[1] - a[1] || 1e-12)), bbox.south]],
    [(point) => point[1] <= bbox.north, (a, b) => [a[0] + (b[0] - a[0]) * ((bbox.north - a[1]) / (b[1] - a[1] || 1e-12)), bbox.north]]
  ];
  let clipped = points;
  for (const [inside, intersect] of edges) clipped = clipRingEdge(clipped, inside, intersect);
  clipped = clipped.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (clipped.length < 3) return [];
  if (clipped[0][0] !== clipped.at(-1)[0] || clipped[0][1] !== clipped.at(-1)[1]) clipped.push([...clipped[0]]);
  return clipped.map((point) => [0, point[0], point[1]]);
}

export function clipLineToBbox(start, end, bbox) {
  const x0 = start[1];
  const y0 = start[2];
  const x1 = end[1];
  const y1 = end[2];
  const dx = x1 - x0;
  const dy = y1 - y0;
  let u0 = 0;
  let u1 = 1;
  const tests = [
    [-dx, x0 - bbox.west],
    [dx, bbox.east - x0],
    [-dy, y0 - bbox.south],
    [dy, bbox.north - y0]
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const ratio = q / p;
    if (p < 0) u0 = Math.max(u0, ratio);
    else u1 = Math.min(u1, ratio);
    if (u0 > u1) return null;
  }
  return [
    [0, clipValue(x0 + u0 * dx, bbox.west, bbox.east), clipValue(y0 + u0 * dy, bbox.south, bbox.north)],
    [0, clipValue(x0 + u1 * dx, bbox.west, bbox.east), clipValue(y0 + u1 * dy, bbox.south, bbox.north)]
  ];
}

export function triangulate(flatCoordinates) {
  const points = [];
  for (let index = 0; index < flatCoordinates.length; index += 2) {
    points.push({ point: [flatCoordinates[index], flatCoordinates[index + 1]], sourceIndex: index / 2 });
  }
  if (points.length > 1) {
    const first = points[0].point;
    const last = points.at(-1).point;
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  if (points.length < 3) return [];

  let signedArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = (index + 1) % points.length;
    signedArea += points[index].point[0] * points[next].point[1] - points[next].point[0] * points[index].point[1];
  }
  if (signedArea < 0) points.reverse();

  const indices = [];
  let guard = points.length * points.length * 2;
  while (points.length > 3 && guard > 0) {
    let clipped = false;
    for (let index = 0; index < points.length; index += 1) {
      const previous = (index + points.length - 1) % points.length;
      const next = (index + 1) % points.length;
      const a = points[previous].point;
      const b = points[index].point;
      const c = points[next].point;
      if (area(a, b, c) <= 1e-8) continue;
      let containsPoint = false;
      for (let other = 0; other < points.length; other += 1) {
        if (other === previous || other === index || other === next) continue;
        if (pointInTriangle(points[other].point, a, b, c)) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;
      indices.push(points[previous].sourceIndex, points[index].sourceIndex, points[next].sourceIndex);
      points.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      const index = points.findIndex((entry, current) => {
        const previous = (current + points.length - 1) % points.length;
        const next = (current + 1) % points.length;
        return Math.abs(area(points[previous].point, entry.point, points[next].point)) <= 1e-8;
      });
      if (index < 0) throw new Error('Unable to triangulate polygon: possible self-intersection');
      points.splice(index, 1);
    }
    guard -= 1;
  }
  if (points.length === 3) {
    indices.push(points[0].sourceIndex, points[1].sourceIndex, points[2].sourceIndex);
  }
  return indices;
}
