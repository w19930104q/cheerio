/**
 * Extraction over a virtual composed tree.
 *
 * This mirrors {@link extract} but runs every selector and value lookup
 * against a {@link ComposedView}, so declarative shadow roots are expanded and
 * `<slot>` elements are flattened before any matching happens.
 *
 * @module cheerio/extract-composed
 */

import * as select from 'cheerio-select';
import type { AnyNode } from 'domhandler';
import type { Cheerio } from '../cheerio.js';
import {
  ComposedElement,
  type ComposedNode,
  ComposedView,
  composedAdapter,
  composedInnerHTML,
  composedInnerText,
  composedOuterHTML,
  composedResolvedURL,
  composedTextContent,
} from './composed.js';
import {
  type ExtractDescriptorFn,
  type ExtractedMap,
  type ExtractMap,
  getExtractDescr,
} from './extract-descriptors.js';

/** Tags whose `href` is resolved against the document's `baseURI`. */
const hrefTags = new Set(['a', 'link']);
/** Tags whose `src` is resolved against the document's `baseURI`. */
const srcTags = new Set(['img', 'iframe', 'audio', 'video', 'source']);
/** Boolean HTML attributes, mirroring the list used by the `prop` module. */
const rboolean =
  /^(?:autofocus|autoplay|async|checked|controls|defer|disabled|hidden|loop|multiple|open|readonly|required|scoped|selected)$/i;

/**
 * A scoped selection inside a composed view. It implements just enough of the
 * extraction surface to run {@link ExtractMap} descriptors: selector matching
 * against the composed tree, and value resolution against composed markup and
 * text.
 */
export class ComposedSelection {
  /** The view the selection belongs to. */
  readonly view: ComposedView;
  /** Wrappers making up the current selection, in composed tree order. */
  readonly wrappers: ComposedNode[];

  constructor(view: ComposedView, wrappers: ComposedNode[]) {
    this.view = view;
    this.wrappers = wrappers;
  }

  /** Options of the underlying document. */
  private get options() {
    return this.view.options;
  }

  /**
   * Find composed elements matching a selector, searching the descendants of
   * every wrapper in the selection.
   *
   * @param selector - The CSS selector to match.
   * @param limit - Maximum number of matches to return.
   * @returns A new selection containing the matched element wrappers.
   */
  find(selector: string, limit: number): ComposedSelection {
    if (this.wrappers.length === 0) {
      return new ComposedSelection(this.view, []);
    }

    const context = this.wrappers;
    const elems = context.flatMap((wrapper) => wrapper.children);
    const options = {
      // css-select walks the virtual composed tree through this adapter.
      adapter: composedAdapter,
      context,
      root: this.view.root,

      // Pass options that are recognized by `cheerio-select`.
      xmlMode: this.options.xmlMode,
      lowerCaseTags: this.options.lowerCaseTags,
      lowerCaseAttributeNames: this.options.lowerCaseAttributeNames,
      pseudos: this.options.pseudos,
      quirksMode: this.options.quirksMode,
    } as unknown as Parameters<typeof select.select>[2];

    const matches = select.select(selector, elems as never, options, limit);
    return new ComposedSelection(
      this.view,
      matches as unknown as ComposedNode[],
    );
  }

  /**
   * Resolve a descriptor value for the first wrapper of the selection.
   *
   * @param value - The descriptor's `value` specification.
   * @param key - The map key being extracted.
   * @param result - The result object built so far.
   * @returns The extracted value.
   */
  resolve(
    value: string | ExtractDescriptorFn | ExtractMap,
    key: string,
    result: Record<string, unknown>,
  ): unknown {
    const wrapper = this.wrappers[0];

    if (typeof value === 'function') {
      return value((wrapper as ComposedElement).node, key, result);
    }

    if (typeof value === 'object') {
      return extractFromSelection(this, value);
    }

    return this.prop(value, wrapper);
  }

  /**
   * Read a property of a composed wrapper the same way
   * {@link module:cheerio/attributes.prop} does, but using composed markup and
   * text.
   *
   * @param name - The property name.
   * @param wrapper - The wrapper to read from; defaults to the first match.
   * @returns The property's value.
   */
  prop(name: string, wrapper: ComposedNode = this.wrappers[0]): unknown {
    if (wrapper instanceof ComposedElement) {
      switch (name) {
        case 'tagName':
        case 'nodeName':
          return wrapper.node.name.toUpperCase();

        case 'href':
        case 'src': {
          if (!(name === 'href' ? hrefTags : srcTags).has(wrapper.node.name)) {
            return wrapper.node.attribs?.[name];
          }
          return composedResolvedURL(wrapper, name, this.options);
        }

        case 'innerHTML':
          return composedInnerHTML(wrapper, this.options);

        case 'outerHTML':
          return composedOuterHTML(wrapper, this.options);

        case 'innerText':
          return composedInnerText(wrapper);

        case 'textContent':
          return composedTextContent(wrapper);

        default:
          return this.readGenericProp(wrapper, name);
      }
    }

    if (name === 'textContent' || name === 'innerText') {
      return composedTextContent(wrapper);
    }

    return undefined;
  }

  /**
   * Resolve non-special property names, mirroring `prop`'s fallback to element
   * fields and attributes.
   *
   * @param wrapper - The element wrapper to read from.
   * @param name - The property name.
   * @returns The property's value.
   */
  private readGenericProp(wrapper: ComposedElement, name: string): unknown {
    const node = wrapper.node as unknown as Record<string, unknown>;
    if (name in node && name !== 'name' && name !== 'type') {
      return node[name];
    }
    const value = wrapper.node.attribs?.[name];
    if (!this.options.xmlMode && rboolean.test(name)) {
      return value !== undefined;
    }
    return value;
  }
}

/**
 * Run an extraction map against every wrapper of a selection.
 *
 * @param selection - The selection to extract from.
 * @param map - The descriptor map.
 * @returns The extracted values.
 */
function extractFromSelection(
  selection: ComposedSelection,
  map: ExtractMap,
): Record<string, unknown> {
  const ret: Record<string, unknown> = {};

  for (const key in map) {
    if (!Object.hasOwn(map, key)) continue;
    const descr = map[key];
    const isArray = Array.isArray(descr);

    const { selector, value } = getExtractDescr(isArray ? descr[0] : descr);

    if (isArray) {
      const matches = selection.find(selector, Number.POSITIVE_INFINITY);
      ret[key] = matches.wrappers
        .map((wrapper) =>
          new ComposedSelection(selection.view, [wrapper]).resolve(
            value,
            key,
            ret,
          ),
        )
        .filter((item) => item != null);
    } else {
      const match = selection.find(selector, 1);
      ret[key] =
        match.wrappers.length > 0 ? match.resolve(value, key, ret) : undefined;
    }
  }

  return ret;
}

/**
 * Extract multiple values from the composed tree of a document or selection.
 *
 * The descriptor format is identical to {@link extract}: selector strings
 * default to `textContent`, objects can specify another `value` or a nested
 * map, and array-wrapped descriptors collect every match. Selectors,
 * `textContent` and `innerHTML` are computed on the composed tree; `href` and
 * `src` are still resolved against the original document's `baseURI`.
 *
 * The underlying DOM is never modified, and no scripts are executed.
 *
 * @param map - An object describing the values to extract.
 * @returns An object containing the extracted values.
 */
export function extractComposed<M extends ExtractMap, T extends AnyNode>(
  this: Cheerio<T>,
  map: M,
): ExtractedMap<M> {
  const rootNode = this._root?.[0];
  if (!rootNode) {
    throw new Error('extractComposed requires a document root');
  }

  // The view is always built from the real document root: shadow hosts need
  // their physical `<template>` child, which a detached fragment would lose.
  const view = new ComposedView(
    rootNode as unknown as ConstructorParameters<typeof ComposedView>[0],
    this.options,
  );

  // Narrow the extraction scope to the physical nodes the selection covers,
  // when the method is invoked on something narrower than the document root.
  const scoped =
    this.length > 0 && this.toArray().every((node) => node !== rootNode);

  const roots = scoped
    ? this.toArray().map((node) => {
        const wrapper = view.getWrapper(node);
        if (!wrapper) {
          throw new Error(
            'extractComposed: the selected node is not part of the composed tree',
          );
        }
        return wrapper;
      })
    : [view.root];

  const selection = new ComposedSelection(view, roots);
  return extractFromSelection(selection, map) as ExtractedMap<M>;
}
