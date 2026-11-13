import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decodeStream, loadBuffer } from './index.js';
import { load } from './load-parse.js';

// Returns a promise and a resolve function
function getPromise() {
  let cb!: (
    error: Error | null | undefined,
    $: ReturnType<typeof load>,
  ) => void;
  const promise = new Promise<ReturnType<typeof load>>((resolve, reject) => {
    cb = (error, $) => (error ? reject(error) : resolve($));
  });

  return { promise, cb };
}

describe('useDocumentBaseURI', () => {
  describe('HTML documents', () => {
    it('should resolve links against the first <base> element with an href', () => {
      const $ = load(
        '<html><head><base href="https://example.com/sub/" /><base href="https://other.example/" /></head><body><a id="a" href="page.html">a</a><img id="i" src="image.png" /></body></html>',
        { useDocumentBaseURI: true },
      );

      expect($('#a').prop('href')).toBe('https://example.com/sub/page.html');
      expect($('#i').prop('src')).toBe('https://example.com/sub/image.png');
    });

    it('should ignore <base> elements without an href', () => {
      const $ = load(
        '<html><head><base target="_blank" /></head><body><a href="page.html">a</a></body></html>',
        {
          useDocumentBaseURI: true,
          baseURI: 'https://example.com/dir/',
        },
      );

      expect($('a').prop('href')).toBe('https://example.com/dir/page.html');
    });

    it('should resolve a relative <base> href against the baseURI option', () => {
      const $ = load(
        '<html><head><base href="../sub/" /></head><body><a href="page.html">a</a></body></html>',
        {
          useDocumentBaseURI: true,
          baseURI: 'https://example.com/dir/page',
        },
      );

      expect($('a').prop('href')).toBe('https://example.com/sub/page.html');
    });

    it('should fall back to the baseURI option if the <base> href is invalid', () => {
      const $ = load(
        '<html><head><base href="http://invalid host/" /></head><body><a href="page.html">a</a></body></html>',
        {
          useDocumentBaseURI: true,
          baseURI: 'https://example.com/dir/',
        },
      );

      expect($('a').prop('href')).toBe('https://example.com/dir/page.html');
    });

    it('should keep the original attribute if no absolute base can be determined', () => {
      const $ = load(
        '<html><head><base href="relative/" /></head><body><a id="a" href="page.html">a</a></body></html>',
        { useDocumentBaseURI: true },
      );

      expect($('#a').prop('href')).toBe('page.html');

      const $noBase = load('<a href="page.html">a</a>', {
        useDocumentBaseURI: true,
      });
      expect($noBase('a').prop('href')).toBe('page.html');
    });

    it('should resolve query-only and fragment-only links', () => {
      const $ = load(
        '<html><head><base href="https://example.com/dir/page?x=1" /></head><body><a id="q" href="?y=2">q</a><a id="f" href="#section">f</a></body></html>',
        { useDocumentBaseURI: true },
      );

      expect($('#q').prop('href')).toBe('https://example.com/dir/page?y=2');
      expect($('#f').prop('href')).toBe(
        'https://example.com/dir/page?x=1#section',
      );
    });

    it('should not rewrite attributes', () => {
      const $ = load(
        '<html><head><base href="https://example.com/sub/" /></head><body><a href="page.html">a</a></body></html>',
        { useDocumentBaseURI: true },
      );

      expect($('a').prop('href')).toBe('https://example.com/sub/page.html');
      expect($('a').attr('href')).toBe('page.html');
    });

    it('should resolve against the current tree when the <base> is modified or removed', () => {
      const $ = load(
        '<html><head><base href="https://one.example/" /><base href="https://two.example/" /></head><body><a href="page.html">a</a></body></html>',
        { useDocumentBaseURI: true },
      );

      expect($('a').prop('href')).toBe('https://one.example/page.html');

      // Modifying the first <base> changes the result.
      $('base').first().attr('href', 'https://changed.example/');
      expect($('a').prop('href')).toBe('https://changed.example/page.html');

      // Removing the first <base> lets the second one apply.
      $('base').first().remove();
      expect($('a').prop('href')).toBe('https://two.example/page.html');

      // Removing all <base> elements leaves no document base.
      $('base').remove();
      expect($('a').prop('href')).toBe('page.html');
    });

    it('should not inherit a base from former ancestors after detaching', () => {
      const $ = load(
        '<html><head><base href="https://example.com/sub/" /></head><body><a href="page.html">a</a></body></html>',
        { useDocumentBaseURI: true },
      );

      const $a = $('a').remove();

      expect($a.prop('href')).toBe('page.html');
    });

    it('should not use the document base for nodes that were never attached', () => {
      const $ = load(
        '<html><head><base href="https://example.com/sub/" /></head><body></body></html>',
        { useDocumentBaseURI: true, baseURI: 'https://fallback.example/dir/' },
      );

      expect($('<a href="page.html">a</a>').prop('href')).toBe(
        'https://fallback.example/dir/page.html',
      );
    });

    it('should use the target document base after moving a node to another document', () => {
      const $source = load(
        '<html><head><base href="https://one.example/" /></head><body><a href="page.html">a</a></body></html>',
        { useDocumentBaseURI: true },
      );
      const $target = load(
        '<html><head><base href="https://two.example/" /></head><body></body></html>',
        { useDocumentBaseURI: true },
      );

      const $clone = $source('a').clone();
      $target('body').append($clone);

      expect($target('a').prop('href')).toBe('https://two.example/page.html');
      // The source document is unaffected.
      expect($source('a').prop('href')).toBe('https://one.example/page.html');
    });

    it('should extract links consistently with prop', () => {
      const $ = load(
        '<html><head><base href="https://example.com/sub/" /></head><body><a href="page.html">a</a></body></html>',
        { useDocumentBaseURI: true },
      );

      const extracted = $.extract({ link: { selector: 'a', value: 'href' } });

      expect(extracted).toStrictEqual({ link: $('a').prop('href') });
      expect(extracted.link).toBe('https://example.com/sub/page.html');
    });

    it('should ignore <base> elements when the mode is disabled', () => {
      const html =
        '<html><head><base href="https://example.com/sub/" /></head><body><a href="page.html">a</a></body></html>';

      // Without `baseURI`, the attribute is returned as-is.
      expect(load(html)('a').prop('href')).toBe('page.html');

      // With `baseURI`, only the `baseURI` option is used.
      expect(
        load(html, { baseURI: 'https://fallback.example/dir/' })('a').prop(
          'href',
        ),
      ).toBe('https://fallback.example/dir/page.html');
    });
  });

  describe('XML documents', () => {
    const atomFeed = `
      <feed xml:base="https://example.com/feed/">
        <entry xml:base="entry/">
          <link href="page.html" />
        </entry>
      </feed>
    `;

    it('should resolve links against nested xml:base attributes', () => {
      const $ = load(atomFeed, { xml: true, useDocumentBaseURI: true });

      expect($('link').prop('href')).toBe(
        'https://example.com/feed/entry/page.html',
      );
    });

    it('should fall back to the parent xml:base if one is invalid', () => {
      const $ = load(
        `
          <feed xml:base="https://example.com/feed/">
            <entry xml:base="http://invalid host/">
              <link href="page.html" />
            </entry>
          </feed>
        `,
        { xml: true, useDocumentBaseURI: true },
      );

      expect($('link').prop('href')).toBe('https://example.com/feed/page.html');
    });

    it('should resolve a relative xml:base against the baseURI option', () => {
      const $ = load(
        '<feed xml:base="feed/"><link href="page.html" /></feed>',
        {
          xml: true,
          useDocumentBaseURI: true,
          baseURI: 'https://example.com/',
        },
      );

      expect($('link').prop('href')).toBe('https://example.com/feed/page.html');
    });

    it('should support prefixed link elements', () => {
      const $ = load(
        `
          <feed xmlns:atom="http://www.w3.org/2005/Atom" xml:base="https://example.com/feed/">
            <atom:link href="page.html" />
          </feed>
        `,
        { xml: true, useDocumentBaseURI: true },
      );

      expect($(String.raw`atom\:link`).prop('href')).toBe(
        'https://example.com/feed/page.html',
      );
    });

    it('should re-resolve when a node is moved within the tree', () => {
      const $ = load(
        `
          <feed xml:base="https://example.com/">
            <entry xml:base="a/"><link href="page.html" /></entry>
            <entry xml:base="b/" />
          </feed>
        `,
        { xml: true, useDocumentBaseURI: true },
      );

      const $link = $('link');
      expect($link.prop('href')).toBe('https://example.com/a/page.html');

      $('entry').last().append($link);
      expect($('link').prop('href')).toBe('https://example.com/b/page.html');
    });

    it('should not inherit xml:base from former ancestors after detaching', () => {
      const $ = load(atomFeed, { xml: true, useDocumentBaseURI: true });

      const $link = $('link').remove();

      expect($link.prop('href')).toBe('page.html');
    });

    it('should keep the original attribute if no absolute base can be determined', () => {
      const $ = load(
        '<feed xml:base="relative/"><link href="page.html" /></feed>',
        { xml: true, useDocumentBaseURI: true },
      );

      expect($('link').prop('href')).toBe('page.html');
    });

    it('should ignore xml:base when the mode is disabled', () => {
      const $ = load(atomFeed, {
        xml: true,
        baseURI: 'https://fallback.example/',
      });

      expect($('link').prop('href')).toBe('https://fallback.example/page.html');
    });
  });

  describe('loading methods', () => {
    const html =
      '<html><head><base href="/sub/" /></head><body><a href="page.html">a</a></body></html>';
    const options = {
      useDocumentBaseURI: true,
      baseURI: 'https://example.com/dir/',
    } as const;

    it('should produce consistent results across load, loadBuffer and decodeStream', async () => {
      const expected = 'https://example.com/sub/page.html';

      expect(load(html, options)('a').prop('href')).toBe(expected);
      expect(loadBuffer(Buffer.from(html), options)('a').prop('href')).toBe(
        expected,
      );

      const { promise, cb } = getPromise();
      const stream = decodeStream(options, cb);
      expect(stream).toBeInstanceOf(Writable);
      stream.end(Buffer.from(html));

      const $ = await promise;
      expect($('a').prop('href')).toBe(expected);
    });
  });
});
