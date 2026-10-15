import { useCallback, useEffect, useState } from "react";
import { api, errorText, type Message } from "./data";
import { conversationFor, rememberConversation } from "./store";

// The researcher's conversation with the org's agent about one benchmark: B ·
// Agente in the workspace. Kept in D1, so it follows them across devices.

export function useAgentChat(convKey: string) {
  const [convId, setConvId] = useState<string | null>(() => conversationFor(convKey));
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Not remembered in this browser: the researcher's latest conversation about
  // this benchmark, kept in D1, so the work follows them across devices.
  useEffect(() => {
    if (convId) return;
    let cancelled = false;
    api
      .conversations(convKey)
      .then(({ conversations }) => {
        const latest = conversations[0];
        if (!latest || cancelled) return;
        rememberConversation(convKey, latest.id);
        setConvId(latest.id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [convId, convKey]);

  useEffect(() => {
    if (!convId) return;
    let cancelled = false;
    api
      .messages(convId)
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        // A conversation this browser remembered from before D1 kept the benchmark.
        void api.tagConversation(convId, convKey).catch(() => {});
      })
      .catch(() => {
        // Gone or not ours: start fresh.
        rememberConversation(convKey, null);
        if (!cancelled) setConvId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [convId, convKey]);

  const send = useCallback(
    async (text: string, opts: { quiet?: boolean } = {}): Promise<string | null> => {
      const message = text.trim();
      if (!message) return null;
      setPending(true);
      setError(null);
      if (!opts.quiet) {
        setMessages((m) => [...m, { id: `local-${Date.now()}`, role: "user", content: message, createdAt: new Date().toISOString() }]);
      }
      try {
        let id = convId;
        if (!id) {
          id = (await api.createConversation(convKey)).id;
          rememberConversation(convKey, id);
          setConvId(id);
        }
        const { reply } = await api.sendTurn(id, message);
        setMessages((m) => [
          ...m,
          ...(opts.quiet ? [{ id: `local-q-${Date.now()}`, role: "user" as const, content: message, createdAt: new Date().toISOString() }] : []),
          { id: `local-r-${Date.now()}`, role: "assistant", content: reply, createdAt: new Date().toISOString() },
        ]);
        return id;
      } catch (err) {
        setError(errorText(err));
        throw err;
      } finally {
        setPending(false);
      }
    },
    [convId, convKey],
  );

  return { convId, messages, pending, error, send, setError };
}
