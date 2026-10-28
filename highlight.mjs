// Regular-expression highlighting runs here, off the main thread, so the
// interface can stop a slow pattern by terminating the worker.
import {matchRanges, termPatterns} from './model.mjs';

onmessage = ({data}) => {
  const patterns = termPatterns(data.query);
  postMessage({token: data.token, results: data.segments.map(segment => [segment.id, matchRanges(segment.text, patterns)])});
};
