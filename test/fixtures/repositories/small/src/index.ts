import { alpha } from './cycle/a.js';
import { formatTotal } from './format.js';
import { add } from './math/index.js';
import { currentName } from './rename/new-name.js';

export { add } from './math/index.js';

export function calculate(values: number[]): string {
  const total = values.reduce(add, 0);
  return `${currentName}:${alpha.name}: ${formatTotal(total)}`;
}
