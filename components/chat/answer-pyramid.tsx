'use client';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CitedText } from './citation-pills';
import { splitAnswerLead } from '@/lib/chat/answer-shape';
import type { CitedSource } from '@/lib/chat/citations';

/** Truncated pyramid for long settled assistant answers: the essential
 *  answer renders first and the rest folds behind an inline disclosure.
 *  It never summarises or rewrites — it only decides where the fold goes.
 *  Short answers, user messages and anything still streaming render whole. */
export function AnswerPyramid({
  messageId,
  text,
  sources,
}: {
  messageId: string;
  text: string;
  sources: CitedSource[];
}) {
  const split = splitAnswerLead(text);
  if (!split)
    return (
      <CitedText messageId={messageId} text={text} sources={sources} streaming={false} settled />
    );
  return (
    <>
      <CitedText
        messageId={messageId}
        text={split.lead}
        sources={sources}
        streaming={false}
        settled
      />
      <Collapsible className="chat-answer-more">
        <CollapsibleTrigger className="chat-answer-more-trigger">
          Show full breakdown
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CitedText
            messageId={messageId}
            text={split.rest}
            sources={sources}
            streaming={false}
            settled
          />
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
