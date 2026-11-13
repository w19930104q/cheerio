/**
 * Descriptor types and helpers shared by {@link extract} and
 * {@link extractComposed}.
 *
 * @module cheerio/extract-descriptors
 */

import type { Element } from 'domhandler';
import type { prop } from './attributes.js';

type ExtractDescriptorFn = (
  el: Element,
  key: string,
  // TODO: This could be typed with ExtractedMap
  obj: Record<string, unknown>,
) => unknown;

interface ExtractDescriptor {
  selector: string;
  value?: string | ExtractDescriptorFn | ExtractMap;
}

type ExtractValue = string | ExtractDescriptor | [string | ExtractDescriptor];

/** Descriptor map used by {@link extract} and {@link extractComposed}. */
export type ExtractMap = Record<string, ExtractValue>;

type ExtractedValue<V extends ExtractValue> = V extends [
  string | ExtractDescriptor,
]
  ? NonNullable<ExtractedValue<V[0]>>[]
  : V extends string
    ? string | undefined
    : V extends ExtractDescriptor
      ? V['value'] extends infer U
        ? U extends ExtractMap
          ? ExtractedMap<U> | undefined
          : U extends ExtractDescriptorFn
            ? ReturnType<U> | undefined
            : ReturnType<typeof prop> | undefined
        : never
      : never;

/** Result type computed from an {@link ExtractMap}. */
export type ExtractedMap<M extends ExtractMap> = {
  [key in keyof M]: ExtractedValue<M[key]>;
};

export type { ExtractDescriptor, ExtractDescriptorFn };

/**
 * Normalize a descriptor into its `selector`/`value` pair.
 *
 * @param descr - Either a selector string or a descriptor object.
 * @returns A descriptor with both fields populated.
 */
export function getExtractDescr(
  descr: string | ExtractDescriptor,
): Required<ExtractDescriptor> {
  if (typeof descr === 'string') {
    return { selector: descr, value: 'textContent' };
  }

  return {
    selector: descr.selector,
    value: descr.value ?? 'textContent',
  };
}
