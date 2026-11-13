/**
 * A read-only, virtual view of a document that expands declarative shadow
 * roots (`<template shadowrootmode="…">`) and flattens `<slot>` elements the
 * way a browser would when computing the composed tree.
 *
 * The original DOM is never modified: the view is made of wrapper nodes that
 * reference the parsed nodes. Physical nodes can appear more than once in the
 * view (a slotted node shows up inside a slot), but each occurrence keeps the
 * exact same object identity.
 *
 * @module cheerio/composed
 */

import renderHTML from 'dom-serializer';
import { ElementType } from 'domelementtype';
import {
  type AnyNode,
  type ChildNode,
  type Document,
  Element,
  hasChildren,
  isTag,
  isText,
  Text,
} from 'domhandler';
import type { InternalOptions } from '../options.js';

/** Predicate used by selector matching. */
type Predicate<Value> = (value: Value) => boolean;

/**
 * Structure-compatible subset of css-select's `Adapter` interface. Declared
 * locally because css-select does not expose `Adapter` from its package entry
 * point under Node16 module resolution.
 */
export interface ComposedAdapter<Node, ElementNode extends Node> {
  isTag: (node: Node) => node is ElementNode;
  existsOne: (test: Predicate<ElementNode>, elems: Node[]) => boolean;
  getAttributeValue: (elem: ElementNode, name: string) => string | undefined;
  getChildren: (node: Node) => Node[];
  getName: (elem: ElementNode) => string;
  getParent: (node: ElementNode) => Node | null;
  getSiblings: (node: Node) => Node[];
  prevElementSibling?: (node: Node) => ElementNode | null;
  getText: (node: Node) => string;
  hasAttrib: (elem: ElementNode, name: string) => boolean;
  removeSubsets: (nodes: Node[]) => Node[];
  findAll: (test: Predicate<ElementNode>, nodes: Node[]) => ElementNode[];
  findOne: (test: Predicate<ElementNode>, elems: Node[]) => ElementNode | null;
  equals?: (a: Node, b: Node) => boolean;
}

/** Name of the attribute that marks a declarative shadow-root template. */
const SHADOW_ROOT_MODE = 'shadowrootmode';
/** Value of `shadowrootmode` that makes the shadow root accessible. */
const SHADOW_ROOT_OPEN = 'open';

/**
 * A node in the virtual composed tree. Every wrapper points at the physical
 * node it represents.
 */
export abstract class ComposedNode {
  /** The physical node this wrapper represents. */
  readonly node: AnyNode;
  /** Composed parent; `null` for the root of the view. */
  parent: ComposedNode | null = null;
  /** Composed children, in tree order. */
  children: ComposedNode[] = [];
  /** Mirrors {@link AnyNode.type} so generic node predicates keep working. */
  abstract readonly type: ElementType;

  constructor(node: AnyNode) {
    this.node = node;
  }
}

/** A composed wrapper around a document (root) node. */
export class ComposedRoot extends ComposedNode {
  readonly type: ElementType = ElementType.Root;

  constructor(node: Document) {
    super(node);
  }
}

/** A composed wrapper around an element node. */
export class ComposedElement extends ComposedNode {
  declare readonly node: Element;
  declare readonly type: ElementType;

  constructor(node: Element) {
    super(node);
    this.node = node;
    this.type = node.type;
  }
}

/** A composed wrapper around a text (or other non-element) node. */
export class ComposedText extends ComposedNode {
  readonly type: ElementType;

  constructor(node: AnyNode) {
    super(node);
    this.type = node.type;
  }
}

/**
 * Find the first direct child of `host` that is a declarative shadow-root
 * template. Only the first one counts, mirroring the browser rule that an
 * element can only have one shadow root.
 *
 * @param host - The potential shadow host.
 * @returns The template element, or `null` if there is none.
 */
function findShadowTemplate(host: Element): Element | null {
  for (const child of host.children) {
    if (
      isTag(child) &&
      child.name === 'template' &&
      SHADOW_ROOT_MODE in child.attribs
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Get the nodes that make up a template's content.
 *
 * The parsers represent template content in one of two ways:
 *
 * - A single `root` document-fragment child of the `<template>` (the usual
 *   full-document parse5 path).
 * - The content elements as direct children of the `<template>` (fragment
 *   parsing paths).
 *
 * @param template - The template element.
 * @returns The template's content nodes, or an empty list if it has none.
 */
function getTemplateContent(template: Element): AnyNode[] {
  if (template.children.length === 0) return [];

  const [first] = template.children;
  if (first.type === ElementType.Root) {
    return hasChildren(first) ? [...first.children] : [];
  }

  return [...template.children];
}

/**
 * Collect the direct light children of a shadow host that participate in slot
 * assignment: element nodes, plus non-whitespace text. Whitespace-only text
 * between elements never gets assigned to slots in a declarative shadow tree.
 *
 * The shadow template itself is not a light child and is skipped here.
 *
 * @param host - The shadow host.
 * @param template - The host's shadow template (excluded from the result).
 * @returns The assignable light nodes, in tree order.
 */
function getAssignableLightNodes(
  host: Element,
  template: Element,
): ChildNode[] {
  const nodes: ChildNode[] = [];
  for (const child of host.children) {
    if (child === template) continue;
    if (isTag(child)) {
      nodes.push(child);
    } else if (isText(child) && child.data.trim() !== '') {
      nodes.push(child);
    }
  }
  return nodes;
}

/** A virtual view of a document as a composed tree. */
export class ComposedView {
  /** Wrapper of the document root. */
  readonly root: ComposedRoot;
  /** Options of the document the view was built from. */
  readonly options: InternalOptions;

  /**
   * Maps every physical node that appears in the view to one of its wrappers.
   * Wrappers are otherwise created per occurrence, because a slotted node
   * appears in a different composed position than its light-tree location.
   */
  private readonly entryPoints = new Map<AnyNode, ComposedNode>();

  constructor(document: Document, options: InternalOptions) {
    this.options = options;
    this.root = new ComposedRoot(document);
    this.entryPoints.set(document, this.root);
    this.buildChildren(document, this.root, null);
  }

  /**
   * Create a fresh wrapper for a physical node. The same physical node gets a
   * new wrapper for each composed occurrence, while the entry-point map keeps
   * track of the first wrapper for lookups.
   *
   * @param node - The physical node.
   * @returns A wrapper representing this occurrence of `node`.
   */
  private createWrapper(node: AnyNode): ComposedNode {
    const wrapper = isTag(node)
      ? new ComposedElement(node)
      : new ComposedText(node);
    if (!this.entryPoints.has(node)) this.entryPoints.set(node, wrapper);
    return wrapper;
  }

  /**
   * Attach `child` to `parent` in the composed tree.
   *
   * @param parent - The composed parent.
   * @param child - The new composed child.
   */
  private append(parent: ComposedNode, child: ComposedNode): void {
    child.parent = parent;
    parent.children.push(child);
  }

  /**
   * Expand the physical children of `node` into composed children attached to
   * `wrapper`.
   *
   * @param node - The physical node whose children are expanded.
   * @param wrapper - The wrapper corresponding to `node`.
   * @param shadow - The slot assignments of the shadow tree currently being
   *   expanded, or `null` when traversing light content.
   */
  private buildChildren(
    node: AnyNode,
    wrapper: ComposedNode,
    shadow: Map<Element, AnyNode[]> | null,
  ): void {
    if (!hasChildren(node)) return;
    for (const child of node.children) {
      this.buildNode(child, wrapper, shadow);
    }
  }

  /**
   * Build a physical node into the composed tree.
   *
   * @param node - The physical node.
   * @param parent - The composed parent.
   * @param shadow - The slot assignments of the shadow tree currently being
   *   expanded, or `null` when traversing light content.
   */
  private buildNode(
    node: AnyNode,
    parent: ComposedNode,
    shadow: Map<Element, AnyNode[]> | null,
  ): void {
    // Inside a shadow tree, a `<slot>` is replaced by its assigned nodes, or
    // by its fallback content when nothing was assigned to it.
    if (shadow && isTag(node) && node.name === 'slot') {
      const assigned = shadow.get(node);
      if (assigned && assigned.length > 0) {
        for (const assignedNode of assigned) {
          // Slotted nodes come from the light tree, so they are expanded
          // without a shadow context (they may contain nested shadow hosts).
          this.buildNode(assignedNode, parent, null);
        }
      } else {
        this.buildChildren(node, parent, shadow);
      }
      return;
    }

    // A declarative shadow template never appears in the composed tree; a
    // plain `<template>` is an opaque element and is kept without expanding
    // its fragment.
    if (isTag(node) && node.name === 'template') {
      if (SHADOW_ROOT_MODE in node.attribs) return;
      this.append(parent, this.createWrapper(node));
      return;
    }

    const wrapper = this.createWrapper(node);
    this.append(parent, wrapper);

    if (isTag(node)) {
      const template = findShadowTemplate(node);
      if (template) {
        if (template.attribs[SHADOW_ROOT_MODE] === SHADOW_ROOT_OPEN) {
          this.expandOpenShadow(node, template, wrapper);
        }
        // Closed (or unknown mode): keep the host with no composed children.
        return;
      }
    }

    this.buildChildren(node, wrapper, shadow);
  }

  /**
   * Run the slot-assignment algorithm for one shadow tree.
   *
   * - A named slot receives the first still-unassigned light node whose
   *   `slot` attribute matches; later same-named slots receive nothing.
   * - The default slot (no `name` attribute) receives all still-unassigned
   *   light nodes in tree order.
   * - Light nodes that no slot accepts remain unassigned and never appear in
   *   the composed tree.
   *
   * @param template - The open shadow template.
   * @param lightNodes - The host's assignable light nodes.
   * @returns A map from slot elements to their assigned physical nodes.
   */
  private assignSlots(
    template: Element,
    lightNodes: ChildNode[],
  ): Map<Element, AnyNode[]> {
    const assigned = new Map<Element, AnyNode[]>();
    const used = new Set<AnyNode>();
    const claimedNames = new Set<string>();
    let defaultSlot: Element | null = null;

    for (const slot of findSlots(getTemplateContent(template))) {
      const name = slot.attribs['name'];
      if (name === undefined) {
        defaultSlot ??= slot;
        assigned.set(slot, []);
        continue;
      }
      assigned.set(slot, []);
      if (claimedNames.has(name)) continue;

      for (const lightNode of lightNodes) {
        if (used.has(lightNode)) continue;
        if (isTag(lightNode) && lightNode.attribs['slot'] === name) {
          assigned.get(slot)!.push(lightNode);
          used.add(lightNode);
          claimedNames.add(name);
          break;
        }
      }
    }

    if (defaultSlot) {
      for (const lightNode of lightNodes) {
        if (used.has(lightNode)) continue;
        const slotName = isTag(lightNode)
          ? lightNode.attribs['slot']
          : undefined;
        if (slotName === undefined) {
          assigned.get(defaultSlot)!.push(lightNode);
          used.add(lightNode);
        }
      }
    }

    return assigned;
  }

  /**
   * Populate a shadow host's wrapper with its composed shadow tree.
   *
   * @param host - The physical shadow host.
   * @param template - The host's open shadow template.
   * @param wrapper - The wrapper representing the host.
   */
  private expandOpenShadow(
    host: Element,
    template: Element,
    wrapper: ComposedNode,
  ): void {
    const lightNodes = getAssignableLightNodes(host, template);
    const assigned = this.assignSlots(template, lightNodes);

    for (const shadowChild of getTemplateContent(template)) {
      this.buildNode(shadowChild, wrapper, assigned);
    }
  }

  /**
   * Find a wrapper of a physical node, if the node is part of the view.
   *
   * @param node - The physical node.
   * @returns A wrapper of the node, or `undefined` if it is not visible (e.g.
   *   it belongs to a closed shadow tree or was not assigned to a slot).
   */
  getWrapper(node: AnyNode): ComposedNode | undefined {
    return this.entryPoints.get(node);
  }
}

/**
 * Collect every `<slot>` element contained in a fragment, in tree order.
 *
 * Nested shadow hosts are traversed as well: their own slots belong to their
 * own shadow tree, but discovering them here is harmless because each host
 * computes its assignments from the map its own template produced.
 *
 * @param nodes - The fragment's physical nodes.
 * @returns The slot elements found while traversing the fragment.
 */
function findSlots(nodes: AnyNode[]): Element[] {
  const slots: Element[] = [];
  const walk = (node: AnyNode): void => {
    if (isTag(node) && node.name === 'slot') {
      slots.push(node);
      return;
    }
    if (!hasChildren(node)) return;
    for (const child of node.children) walk(child);
  };
  for (const node of nodes) walk(node);
  return slots;
}

/**
 * CSS-select adapter that walks the virtual composed tree instead of the
 * physical DOM.
 */
export const composedAdapter: ComposedAdapter<ComposedNode, ComposedElement> = {
  isTag: (node): node is ComposedElement => node instanceof ComposedElement,

  getAttributeValue: (elem, name) => elem.node.attribs?.[name],

  getChildren: (node) => node.children,

  getName: (elem) => elem.node.name,

  getParent: (node) => node.parent,

  getSiblings: (node) => node.parent?.children ?? [node],

  prevElementSibling: (node) => {
    const siblings = node.parent?.children;
    if (!siblings) return null;
    const index = siblings.indexOf(node);
    for (let i = index - 1; i >= 0; i--) {
      const sibling = siblings[i];
      if (sibling instanceof ComposedElement) return sibling;
    }
    return null;
  },

  getText: (node) => composedTextContent(node),

  hasAttrib: (elem, name) => Object.hasOwn(elem.node.attribs ?? {}, name),

  removeSubsets: (nodes) => {
    let index = nodes.length;
    while (--index >= 0) {
      const node = nodes[index];
      if (index > 0 && nodes.lastIndexOf(node, index - 1) >= 0) {
        nodes.splice(index, 1);
        continue;
      }
      for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
        if (nodes.includes(ancestor)) {
          nodes.splice(index, 1);
          break;
        }
      }
    }
    return nodes;
  },

  existsOne: (test, nodes) =>
    nodes.some(
      (node) =>
        (node instanceof ComposedElement && test(node)) ||
        composedAdapter.existsOne(test, node.children),
    ),

  findAll: (test, nodes) => {
    const result: ComposedElement[] = [];
    const stack: ComposedNode[][] = [nodes];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const node of current) {
        if (node instanceof ComposedElement && test(node)) {
          result.push(node);
        }
        if (node.children.length > 0) stack.push(node.children);
      }
    }
    return result;
  },

  findOne: (test, nodes) => {
    for (const node of nodes) {
      if (node instanceof ComposedElement && test(node)) return node;
      const found = composedAdapter.findOne(test, node.children);
      if (found) return found;
    }
    return null;
  },
};

/**
 * Build a detached, serializable copy of the composed subtree rooted at
 * `wrapper`. Synthetic nodes mirror the physical nodes' names, attributes and
 * types without mutating them, so the serializer (which keys off `type`,
 * `name`, `attribs` and `children`) renders the composed tree correctly.
 *
 * @param wrapper - The wrapper to turn into serializable nodes.
 * @returns A standalone node that `dom-serializer` can render.
 */
function toSerializable(wrapper: ComposedNode): AnyNode {
  if (wrapper instanceof ComposedElement) {
    const { node } = wrapper;
    // Reuse the physical element's constructor type so raw-text elements
    // (`script`, `style`) and other special cases serialize correctly.
    const clone = new Element(
      node.name,
      { ...node.attribs },
      wrapper.children.map(toSerializable) as ChildNode[],
      node.type,
    );
    return clone;
  }

  const { node } = wrapper;
  if (node instanceof Text) {
    return new Text((node as Text).data);
  }

  /*
   * Comments, directives and any other leaf nodes are immutable for
   * serialization purposes, so the physical node can be passed through
   * directly. It is never modified by the serializer.
   */
  return node;
}

/**
 * Serialize a composed wrapper to markup as it appears in the composed tree.
 *
 * @param wrapper - The wrapper to serialize.
 * @param options - Serializer options inherited from the document.
 * @returns The wrapper's outer HTML.
 */
export function composedOuterHTML(
  wrapper: ComposedNode,
  options: InternalOptions,
): string {
  if (wrapper instanceof ComposedRoot) {
    return wrapper.children
      .map((child) => composedOuterHTML(child, options))
      .join('');
  }
  return renderHTML(toSerializable(wrapper), options);
}

/**
 * Compute the `innerHTML` of an element according to the composed tree.
 *
 * @param wrapper - The element wrapper.
 * @param options - Serializer options inherited from the document.
 * @returns The composed inner HTML.
 */
export function composedInnerHTML(
  wrapper: ComposedNode,
  options: InternalOptions,
): string {
  return wrapper.children
    .map((child) => composedOuterHTML(child, options))
    .join('');
}

/**
 * Compute the `textContent` of a node according to the composed tree. Comments
 * are ignored, matching the regular `textContent` implementation.
 *
 * @param wrapper - The wrapper to read.
 * @returns The composed text content.
 */
export function composedTextContent(wrapper: ComposedNode): string {
  if (wrapper.node.type === ElementType.Text) {
    return (wrapper.node as Text).data;
  }
  if (wrapper.node.type === ElementType.Comment) return '';
  return wrapper.children.map(composedTextContent).join('');
}

/**
 * Compute the `innerText` of a node according to the composed tree. Like the
 * regular implementation, this ignores `<script>` and `<style>` contents.
 *
 * @param wrapper - The wrapper to read.
 * @returns The composed inner text.
 */
export function composedInnerText(wrapper: ComposedNode): string {
  const { node } = wrapper;
  if (node.type === ElementType.Text) return (node as Text).data;
  if (
    wrapper instanceof ComposedElement &&
    (node.type === ElementType.Script || node.type === ElementType.Style)
  ) {
    return '';
  }
  let text = wrapper.children.map(composedInnerText).join('');
  if (wrapper instanceof ComposedElement && wrapper.node.name === 'br') {
    text = `\n${text}`;
  }
  return text;
}

/**
 * Resolve `href`/`src` against the document's `baseURI`. The value is read
 * from the physical node, so URLs are always resolved against the original
 * document's base URI even when the node is displayed through a slot.
 *
 * @param wrapper - The element wrapper.
 * @param name - Either `href` or `src`.
 * @param options - Document options containing the base URI.
 * @returns The resolved URL, the raw attribute, or `undefined`.
 */
export function composedResolvedURL(
  wrapper: ComposedElement,
  name: 'href' | 'src',
  options: InternalOptions,
): string | undefined {
  const value = wrapper.node.attribs?.[name];
  if (typeof URL !== 'undefined' && value !== undefined && options.baseURI) {
    return new URL(value, options.baseURI).href;
  }
  return value;
}
