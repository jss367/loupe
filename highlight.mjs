// Regular-expression highlighting runs here, off the main thread, so the
// interface can stop a slow pattern by terminating the worker.
import {scanRanges, termPatterns} from './model.mjs';

onmessage = ({data}) => {
  const patterns = termPatterns(data.query);
  let remaining = data.limit, truncated = false;
  const results = [];
  for (const segment of data.segments) {
    const scan = remaining > 0 ? scanRanges(segment.text, patterns, remaining) : {ranges: [], truncated: true};
    remaining -= scan.ranges.length;
    truncated = truncated || scan.truncated;
    results.push([segment.id, scan.ranges]);
  }
  postMessage({token: data.token, results, truncated});
};
