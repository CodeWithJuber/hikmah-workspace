'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { MessageResponse } from '@/components/ai-elements/message';
import { detectLang } from '@/lib/chat/language';
import {
  findCitationMarkers,
  pillAriaLabel,
  sourceAnchorId,
  sourceLabel,
  type CitedSource,
} from '@/lib/chat/citations';

/** Ancestors whose text is never citation prose: code of any kind, table
 *  cells (splitting there would break the table), and anything already a
 *  link or button (streamdown renders its links as buttons). */
const SKIP_ANCESTOR = 'pre, code, table, a, button, [data-cite-pill]';

function buildPill(n: number, source: CitedSource, messageId: string): HTMLAnchorElement {
  const pill = document.createElement('a');
  pill.className = 'chat-cite';
  pill.href = '#' + sourceAnchorId(messageId, n - 1);
  pill.title = sourceLabel(source);
  pill.setAttribute('aria-label', pillAriaLabel(n, source));
  pill.setAttribute('data-cite-pill', 'true');
  const numeral = document.createElement('span');
  numeral.setAttribute('aria-hidden', 'true');
  numeral.textContent = String(n);
  pill.appendChild(numeral);
  return pill;
}

/**
 * Threads [n] citation markers in an already-rendered answer into superscript
 * pill links pointing at the message's deduped source list. Runs only once
 * the message is settled: during streaming React owns the text nodes and an
 * effect rewriting them would fight the reconciler on every commit.
 *  Module-private: it only ever runs inside CitedText below.
 */
function CitationPills({
  containerRef,
  sources,
  messageId,
  settled,
}: {
  /** Ref of the element wrapping the rendered answer text. */
  containerRef: RefObject<HTMLElement | null>;
  /** Deduped sources, in marker order. */
  sources: CitedSource[];
  messageId: string;
  /** True when the message will not change again (not streaming). */
  settled: boolean;
}) {
  useEffect(() => {
    if (!settled || sources.length === 0) return;
    const root = containerRef.current;
    if (!root || typeof document === 'undefined') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP_ANCESTOR)) return NodeFilter.FILTER_REJECT;
        return findCitationMarkers(node.nodeValue ?? '', sources).length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    // The walker is live: collect first, mutate after.
    const targets: Text[] = [];
    let current = walker.nextNode();
    while (current) {
      targets.push(current as Text);
      current = walker.nextNode();
    }

    for (const textNode of targets) {
      // The node may have been replaced by an earlier iteration's fragment.
      if (!textNode.isConnected) continue;
      const markers = findCitationMarkers(textNode.nodeValue ?? '', sources);
      if (markers.length === 0) continue;
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const marker of markers) {
        if (marker.start > last)
          fragment.appendChild(
            document.createTextNode(textNode.nodeValue!.slice(last, marker.start)),
          );
        fragment.appendChild(buildPill(marker.index + 1, sources[marker.index], messageId));
        last = marker.end;
      }
      if (last < (textNode.nodeValue?.length ?? 0))
        fragment.appendChild(document.createTextNode(textNode.nodeValue!.slice(last)));
      textNode.replaceWith(fragment);
    }
  }, [settled, sources, messageId, containerRef]);

  return null;
}

/**
 * One answer text part: markdown-rendered with `lang` alongside `dir="auto"`,
 * then citation pills threaded in once the message settles. The wrapper div
 * is the pill effect's scope — pills only ever touch this message's text.
 */
export function CitedText({
  messageId,
  text,
  sources,
  streaming,
  settled,
}: {
  messageId: string;
  text: string;
  sources: CitedSource[];
  streaming: boolean;
  settled: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const withPills = settled && sources.length > 0;
  // `lang` rides on the wrapper, not MessageResponse: streamdown's prop type
  // does not accept it, and HTML lang + dir="auto" on the wrapper gives the
  // same per-paragraph bidi and pronunciation behaviour.
  return (
    <>
      <div ref={ref} lang={detectLang(text)} dir="auto">
        <MessageResponse isAnimating={streaming}>{text}</MessageResponse>
      </div>
      {withPills && (
        <CitationPills
          containerRef={ref}
          sources={sources}
          messageId={messageId}
          settled={settled}
        />
      )}
    </>
  );
}
