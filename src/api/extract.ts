import type { AnyNode, Element } from 'domhandler';
import type { Cheerio } from '../cheerio.js';
import {
  type ExtractDescriptorFn,
  type ExtractedMap,
  type ExtractMap,
  getExtractDescr,
} from './extract-descriptors.js';

// Re-export the public descriptor types from their shared module.
export type { ExtractedMap, ExtractMap } from './extract-descriptors.js';

/**
 * Extract multiple values from a document, and store them in an object.
 *
 * @param map - An object containing key-value pairs. The keys are the names of
 *   the properties to be created on the object, and the values are the
 *   selectors to be used to extract the values.
 * @returns An object containing the extracted values.
 */
export function extract<M extends ExtractMap, T extends AnyNode>(
  this: Cheerio<T>,
  map: M,
): ExtractedMap<M> {
  const ret: Record<string, unknown> = {};

  for (const key in map) {
    if (!Object.hasOwn(map, key)) continue;
    const descr = map[key];
    const isArray = Array.isArray(descr);

    const { selector, value } = getExtractDescr(isArray ? descr[0] : descr);

    const fn: ExtractDescriptorFn =
      typeof value === 'function'
        ? value
        : typeof value === 'string'
          ? (el: Element) => this._make(el).prop(value)
          : (el: Element) => this._make(el).extract(value);

    if (isArray) {
      ret[key] = this._findBySelector(selector, Number.POSITIVE_INFINITY)
        .toArray()
        .map((el) => fn(el, key, ret))
        .filter((value) => value != null);
    } else {
      const $ = this._findBySelector(selector, 1);
      ret[key] = $.length > 0 ? fn($[0], key, ret) : undefined;
    }
  }

  return ret as ExtractedMap<M>;
}
