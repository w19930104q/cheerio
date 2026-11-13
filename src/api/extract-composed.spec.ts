import { describe, expect, expectTypeOf, it } from 'vitest';
import * as cheerio from '../index.js';

/**
 * Regression tests for `$.extractComposed`, which runs the regular `extract`
 * descriptor machinery over a virtual composed tree: declarative shadow roots
 * (`<template shadowrootmode>`) are expanded and `<slot>` elements are
 * flattened before any selector matching happens.
 *
 * Markup is written without whitespace inside templates on purpose: shadow
 * content keeps its text nodes, so indentation would show up in
 * `textContent`/`innerHTML` assertions.
 */
describe('$.extractComposed', () => {
  it('replaces named slots with matching light nodes', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<h1><slot name="title"></slot></h1>' +
        '<p><slot></slot></p>' +
        '</template>' +
        '<span slot="title">Hello</span>' +
        '<b>World</b>' +
        '</host>',
    );

    expect(
      $.extractComposed({
        title: 'h1',
        body: 'p',
      }),
    ).toStrictEqual({ title: 'Hello', body: 'World' });
  });

  it('assigns named nodes only to the first slot of that name', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot name="x"><em>fallback-a</em></slot>' +
        '<slot name="x"><em>fallback-b</em></slot>' +
        '</template>' +
        '<b slot="x">light</b>' +
        '</host>',
    );

    // The first slot gets the light node; the second one keeps its fallback.
    expect($.extractComposed({ ems: ['em'] })).toStrictEqual({
      ems: ['fallback-b'],
    });
    expect($.extractComposed({ bs: ['b'] })).toStrictEqual({ bs: ['light'] });
  });

  it('assigns unnamed nodes only to the first default slot', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot><em>first-default</em></slot>' +
        '<hr>' +
        '<slot><em>second-default</em></slot>' +
        '</template>' +
        '<a>1</a><a>2</a>' +
        '</host>',
    );

    expect(
      $.extractComposed({
        ems: ['em'],
        html: { selector: 'host', value: 'innerHTML' },
      }),
    ).toStrictEqual({
      ems: ['second-default'],
      html: '<a>1</a><a>2</a><hr><em>second-default</em>',
    });
  });

  it('uses fallback content only when no node is assigned', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot name="named"><i>named-fb</i></slot>' +
        '<slot><b>default-fb</b></slot>' +
        '</template>' +
        '<span slot="named">named-light</span>' +
        '</host>',
    );

    expect(
      $.extractComposed({ named: 'i', def: 'b', span: ['span'] }),
    ).toStrictEqual({
      named: undefined,
      def: 'default-fb',
      span: ['named-light'],
    });
  });

  it('uses all fallbacks when the host has no light children', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot name="x"><em>fx</em></slot>' +
        '<slot><em>fd</em></slot>' +
        '</template></host>',
    );

    expect($.extractComposed({ ems: ['em'] })).toStrictEqual({
      ems: ['fx', 'fd'],
    });
  });

  it('hides light nodes that no slot accepts', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot name="named"></slot>' +
        '<slot></slot>' +
        '</template>' +
        '<span slot="named">a</span>' +
        '<span slot="missing">b</span>' +
        '<i>c</i>' +
        '</host>',
    );

    expect(
      $.extractComposed({ spans: ['span'], items: ['i'], text: 'host' }),
    ).toStrictEqual({ spans: ['a'], items: ['c'], text: 'ac' });
  });

  it('does not assign whitespace-only text nodes to slots', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot><b>fallback</b></slot>' +
        '</template>' +
        '   <i>x</i>  ' +
        '</host>',
    );

    expect(
      $.extractComposed({
        text: { selector: 'host', value: 'textContent' },
        fallback: ['b'],
      }),
    ).toStrictEqual({ text: 'x', fallback: [] });
  });

  it('keeps the host opaque for a closed shadow root', () => {
    const $ = cheerio.load(
      '<host id="h" data-k="v"><template shadowrootmode="closed">' +
        '<p class="secret">shadow</p>' +
        '<slot></slot>' +
        '</template>' +
        '<span>light</span>' +
        '</host>',
    );

    expect(
      $.extractComposed({
        host: '#h',
        id: { selector: '#h', value: 'id' },
        secret: ['.secret'],
        light: ['span'],
        html: { selector: '#h', value: 'outerHTML' },
      }),
    ).toStrictEqual({
      host: '',
      id: 'h',
      secret: [],
      light: [],
      html: '<host id="h" data-k="v"></host>',
    });
  });

  it('does not expand plain templates without shadowrootmode', () => {
    const $ = cheerio.load(
      '<div><template><p class="inside">n</p></template>' +
        '<p class="outside">o</p></div>',
    );

    expect(
      $.extractComposed({
        inside: ['.inside'],
        outside: ['.outside'],
        templates: ['template'],
      }),
    ).toStrictEqual({ inside: [], outside: ['o'], templates: [''] });
  });

  it('treats an unknown shadowrootmode value like a closed root', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="bogus">' +
        '<p>x</p></template><b>y</b></host>',
    );

    expect(
      $.extractComposed({ host: 'host', ps: ['p'], bs: ['b'] }),
    ).toStrictEqual({ host: '', ps: [], bs: [] });
  });

  it('uses only the first shadow-root template of a host', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open"><slot></slot></template>' +
        '<template shadowrootmode="open"><p>second</p></template>' +
        '<i>light</i></host>',
    );

    // The second template is a regular light child of the host, unassigned to
    // any slot, so neither it nor its `<p>` appears in the composed tree.
    expect($.extractComposed({ is: ['i'], ps: ['p'] })).toStrictEqual({
      is: ['light'],
      ps: [],
    });
  });

  it('expands nested shadow hosts in tree order', () => {
    const $ = cheerio.load(
      '<outer><template shadowrootmode="open">' +
        '<header><inner><template shadowrootmode="open">' +
        '<h3><slot name="heading"></slot></h3>' +
        '</template>' +
        '<h4 slot="heading">inner-light</h4>' +
        '</inner></header>' +
        '<main><slot></slot></main>' +
        '</template>' +
        '<p>outer-light</p>' +
        '</outer>',
    );

    expect(
      $.extractComposed({
        heading: 'h3',
        main: 'main',
        order: { selector: 'outer', value: 'textContent' },
      }),
    ).toStrictEqual({
      heading: 'inner-light',
      main: 'outer-light',
      order: 'inner-lightouter-light',
    });
  });

  it('expands sibling shadow hosts independently', () => {
    const $ = cheerio.load(
      '<main>' +
        '<a-host><template shadowrootmode="open">' +
        '<slot name="t"></slot></template>' +
        '<span slot="t">A</span></a-host>' +
        '<a-host><template shadowrootmode="open">' +
        '<slot name="t"></slot></template>' +
        '<span slot="t">B</span></a-host>' +
        '</main>',
    );

    expect($.extractComposed({ spans: ['span'] })).toStrictEqual({
      spans: ['A', 'B'],
    });
  });

  it('supports nested descriptor maps over the composed tree', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<article><slot name="t"></slot><slot></slot></article>' +
        '</template>' +
        '<h2 slot="t">Title</h2>' +
        '<p>Body</p>' +
        '</host>',
    );

    expect(
      $.extractComposed({
        article: {
          selector: 'article',
          value: { title: 'h2', body: 'p' },
        },
      }),
    ).toStrictEqual({ article: { title: 'Title', body: 'Body' } });
  });

  it('preserves physical node identity instead of cloning', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot name="a"></slot>' +
        '</template>' +
        '<b data-x="42" slot="a">x</b>' +
        '</host>',
    );
    const physical = $('b')[0];
    const seen: unknown[] = [];

    const result = $.extractComposed({
      v: {
        selector: 'b',
        value: (el) => {
          seen.push(el);
          return $(el).attr('data-x');
        },
      },
    });

    expect(result).toStrictEqual({ v: '42' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(physical);
  });

  it('computes textContent, innerText, innerHTML and outerHTML on the composed tree', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<div><slot></slot></div>' +
        '</template>' +
        '<style>.x{}</style>' +
        '<a>l1</a><br><a>l2</a>' +
        '<script>alert(1)</script>' +
        '</host>',
    );

    expect(
      $.extractComposed({
        textContent: { selector: 'host', value: 'textContent' },
        innerText: { selector: 'host', value: 'innerText' },
        innerHTML: { selector: 'host', value: 'innerHTML' },
        outerHTML: { selector: 'host', value: 'outerHTML' },
      }),
    ).toStrictEqual({
      textContent: '.x{}l1l2alert(1)',
      innerText: 'l1\nl2',
      // Slotted elements keep their tags in markup, including raw-text ones;
      // only `innerText` filters `<script>`/`<style>` content.
      innerHTML:
        '<div><style>.x{}</style><a>l1</a><br><a>l2</a>' +
        '<script>alert(1)</script></div>',
      outerHTML:
        '<host><div><style>.x{}</style><a>l1</a><br><a>l2</a>' +
        '<script>alert(1)</script></div></host>',
    });
  });

  it('ignores comments when computing textContent', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot></slot><!-- a comment -->' +
        '</template>' +
        '<b>x</b>' +
        '</host>',
    );

    expect(
      $.extractComposed({ t: { selector: 'host', value: 'textContent' } }),
    ).toStrictEqual({ t: 'x' });
  });

  it('exposes tagName/nodeName as upper-case names', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot></slot>' +
        '</template>' +
        '<span>x</span>' +
        '</host>',
    );

    expect(
      $.extractComposed({
        tag: { selector: 'span', value: 'tagName' },
        node: { selector: 'span', value: 'nodeName' },
      }),
    ).toStrictEqual({ tag: 'SPAN', node: 'SPAN' });
  });

  it('mirrors boolean-attribute prop semantics', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open">' +
        '<slot></slot>' +
        '</template>' +
        '<input type="checkbox" checked>' +
        '</host>',
    );

    expect(
      $.extractComposed({
        checked: { selector: 'input', value: 'checked' },
        disabled: { selector: 'input', value: 'disabled' },
      }),
    ).toStrictEqual({ checked: true, disabled: false });
  });

  it('resolves href/src against the original document baseURI', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open"><slot></slot></template>' +
        '<a href="page?a=1">link</a>' +
        '<img src="/img.png">' +
        '<div href="keep/raw">raw</div>' +
        '</host>',
      { baseURI: 'https://example.com/path/' },
    );

    expect(
      $.extractComposed({
        link: { selector: 'a', value: 'href' },
        img: { selector: 'img', value: 'src' },
        raw: { selector: 'div', value: 'href' },
      }),
    ).toStrictEqual({
      link: 'https://example.com/path/page?a=1',
      img: 'https://example.com/img.png',
      raw: 'keep/raw',
    });
  });

  it('works on fragment-parsed documents', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open"><slot></slot></template>' +
        '<span>x</span></host>',
      null,
      false,
    );

    expect($.extractComposed({ span: 'span', host: 'host' })).toStrictEqual({
      span: 'x',
      host: 'x',
    });
  });

  it('expands lowercase slots under htmlparser2 and XML mode', () => {
    const $ = cheerio.load(
      '<host><template shadowrootmode="open"><slot></slot></template>' +
        '<b>x</b></host>',
      { xmlMode: true },
    );

    expect($.extractComposed({ b: 'b' })).toStrictEqual({ b: 'x' });
  });

  it('treats capitalized Slot elements as ordinary elements in XML mode', () => {
    const $ = cheerio.load(
      '<Host><template shadowrootmode="open"><Slot></Slot></template>' +
        '<B>x</B></Host>',
      { xmlMode: true },
    );

    // XML mode is case-sensitive: `Slot` is not the HTML `slot` element, so
    // nothing is flattened and the light `<B>` stays unassigned.
    expect(
      $.extractComposed({
        slot: ['Slot'],
        b: ['B'],
        host: { selector: 'Host', value: 'innerHTML' },
      }),
    ).toStrictEqual({
      slot: [''],
      b: [],
      host: '<Slot/>',
    });
  });

  it('scopes extraction to the selection when called on a subset', () => {
    const $ = cheerio.load(
      '<section id="s"><host><template shadowrootmode="open">' +
        '<slot></slot></template><b>in</b></host></section><b>out</b>',
    );

    expect($('#s').extractComposed({ bs: ['b'] })).toStrictEqual({
      bs: ['in'],
    });
    expect($.extractComposed({ bs: ['b'] })).toStrictEqual({
      bs: ['in', 'out'],
    });
  });

  it('infers the result type from the descriptor map', () => {
    const $ = cheerio.load('<host></host>');

    expectTypeOf(
      $.extractComposed({
        title: 'h1',
        items: ['li'],
        nested: { selector: 'article', value: { body: 'p' } },
      }),
    ).toEqualTypeOf<{
      title: string | undefined;
      items: string[];
      nested: { body: string | undefined } | undefined;
    }>();
  });

  it('never mutates the original DOM across repeated calls', () => {
    const markup =
      '<host><template shadowrootmode="open">' +
      '<slot name="t"></slot>' +
      '<slot><em>fb</em></slot>' +
      '</template>' +
      '<h2 slot="t">Title</h2>' +
      '<p>Body</p>' +
      '</host>';
    const $ = cheerio.load(markup);

    const before = $.html();
    const template = $('template')[0];
    const host = $('host')[0];
    const h2 = $('h2')[0];
    const slots = $('slot').toArray();

    const map = {
      title: 'h2',
      body: 'p',
      fb: ['em'] as [string],
      html: { selector: 'host', value: 'outerHTML' },
    };
    const first = $.extractComposed(map);
    const second = $.extractComposed(map);

    expect(second).toStrictEqual(first);
    // The serialized document is byte-identical before and after the calls.
    expect($.html()).toBe(before);
    // Declarative shadow structures stay in place.
    expect(template.attribs['shadowrootmode']).toBe('open');
    expect(template.parent).toBe(host);
    expect(slots).toHaveLength(2);
    // parse5 keeps template content under a document-fragment root; every slot
    // must still live inside the original template's content.
    const templateContent = template.children[0] as {
      children?: typeof slots;
    };
    for (const slot of slots) {
      expect(slot.parent).toBe(templateContent);
      expect(templateContent.children).toContain(slot);
    }
    // Light children keep their physical parents.
    expect(h2.parent).toBe(host);
    expect($('p')[0].parent).toBe(host);
    // Nothing was inserted into or removed from the physical host.
    expect(
      host.children.map((node) => (node as { name?: string }).name),
    ).toEqual(['template', 'h2', 'p']);
  });

  it('does not change the behavior of the regular extract', () => {
    const markup =
      '<host><template shadowrootmode="open">' +
      '<slot name="t"></slot>' +
      '</template>' +
      '<h2 slot="t">Title</h2>' +
      '</host>';
    const $ = cheerio.load(markup);

    // Regular extraction sees the physical DOM: slots and templates are not
    // flattened, and shadow content stays inside the template.
    expect($.extract({ h2: 'h2', slots: ['slot'], title: 'h2' })).toStrictEqual(
      { h2: 'Title', slots: [''], title: 'Title' },
    );
    expect($('host').html()).toBe(
      '<template shadowrootmode="open">' +
        '<slot name="t"></slot>' +
        '</template>' +
        '<h2 slot="t">Title</h2>',
    );
  });
});
