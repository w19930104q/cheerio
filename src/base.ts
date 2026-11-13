/**
 * @file Helpers to determine the base URI of a document, as declared by the
 *   document itself: `<base href>` elements in HTML, and `xml:base`
 *   attributes in XML.
 */

import { type AnyNode, type Element, hasChildren, isTag } from 'domhandler';
import { findOne } from 'domutils';
import type { InternalOptions } from './options.js';

/**
 * Resolve a URL against a base, returning `undefined` if no absolute URL can
 * be produced.
 *
 * @param value - The URL to resolve.
 * @param base - The base to resolve against, if any.
 * @returns The resolved absolute URL, or `undefined`.
 */
export function resolveUrl(
  value: string,
  base: string | undefined,
): string | undefined {
  try {
    // An `undefined` base is ignored by the `URL` constructor.
    return new URL(value, base).href;
  } catch {
    return undefined;
  }
}

/**
 * Get the fallback base URI from the options, if it is a valid absolute URL.
 *
 * @param options - The options to get the fallback base URI from.
 * @returns The fallback base URI, or `undefined`.
 */
function getFallbackBaseURI(options: InternalOptions): string | undefined {
  const { baseURI } = options;

  if (baseURI === undefined) return undefined;

  try {
    return new URL(baseURI).href;
  } catch {
    return undefined;
  }
}

/**
 * Get the local name of a tag, stripping a potential namespace prefix. This
 * allows eg. Atom's `<atom:link>` to be recognized as a `link` element.
 *
 * @param tagName - The tag name to get the local name of.
 * @returns The local name.
 */
export function getLocalName(tagName: string): string {
  const colonIndex = tagName.lastIndexOf(':');
  return colonIndex === -1 ? tagName : tagName.slice(colonIndex + 1);
}

/**
 * Get the base URI in effect for an element, as declared by the document
 * itself.
 *
 * - In HTML documents, this is the `href` of the first `<base>` element with
 *   an `href` attribute in the document, resolved against the configured
 *   `baseURI`.
 * - In XML documents, this is the `xml:base` attributes of the element and
 *   its ancestors, resolved layer by layer on top of the configured `baseURI`.
 *
 * Invalid bases are skipped in favor of the enclosing base. The result is
 * computed from the current tree: nodes that are not attached to a document
 * do not inherit a base from former ancestors, and nodes inserted into a
 * different document use that document's base.
 *
 * @param el - The element to get the document base URI for.
 * @param options - The options of the current instance.
 * @returns The document base URI, or `undefined` if no absolute base URI
 *   could be determined.
 */
export function getDocumentBaseURI(
  el: Element,
  options: InternalOptions,
): string | undefined {
  let base = getFallbackBaseURI(options);

  if (options.xmlMode) {
    /*
     * Collect the `xml:base` attributes of the element and its ancestors,
     * then apply them from the outermost ancestor inwards.
     */
    const chain: string[] = [];
    let node: AnyNode | null = el;

    while (node) {
      if (isTag(node)) {
        const xmlBase = node.attribs?.['xml:base'];
        if (xmlBase !== undefined) chain.push(xmlBase);
      }
      node = node.parent;
    }

    for (let i = chain.length - 1; i >= 0; i--) {
      // An invalid `xml:base` falls back to the enclosing base.
      base = resolveUrl(chain[i], base) ?? base;
    }

    return base;
  }

  // Find the root of the tree the element is currently attached to.
  let root: AnyNode = el;
  while (root.parent) root = root.parent;

  // The first `<base>` element with an `href` in document order wins.
  const baseElement = hasChildren(root)
    ? findOne(
        (node) => node.name === 'base' && node.attribs?.['href'] !== undefined,
        root.children,
        true,
      )
    : null;

  if (baseElement) {
    // An invalid `href` falls back to the configured `baseURI`.
    base = resolveUrl(baseElement.attribs['href'], base) ?? base;
  }

  return base;
}
