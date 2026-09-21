// Server-sent events for React Native (react-native-sse), as a hook.
// The server ends a stream with an `ended` event: {reason:"gone"} means the
// wait/trip no longer exists; {reconnect:true} means "max age, reconnect".
import { useEffect, useRef } from "react";
import EventSource from "react-native-sse";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;

type Options<T> = {
  event: string;
  token?: string;
  onEvent: (data: T) => void;
  onEnded?: (reason: string) => void;
  onError?: (message: string) => void;
};

export function useSSE<T>(path: string | null, opts: Options<T>) {
  const cb = useRef(opts);
  useEffect(() => {
    cb.current = opts;
  });

  useEffect(() => {
    if (!path || !BASE) return;
    let closed = false;
    let es: EventSource<string> | null = null;

    const open = () => {
      if (closed) return;
      es = new EventSource<string>(`${BASE}/api${path}`, {
        headers: cb.current.token ? { Authorization: `Bearer ${cb.current.token}` } : {},
        pollingInterval: 3000, // auto-reconnect delay after the server closes
      });
      es.addEventListener(cb.current.event as any, (e: any) => {
        try {
          cb.current.onEvent(JSON.parse(e.data));
        } catch {}
      });
      es.addEventListener("ended" as any, (e: any) => {
        let data: any = {};
        try {
          data = JSON.parse(e.data);
        } catch {}
        if (data.reconnect) return; // library reconnects on its own
        closed = true;
        es?.close();
        cb.current.onEnded?.(data.reason ?? "gone");
      });
      es.addEventListener("error", (e: any) => {
        cb.current.onError?.(e?.message || "connection lost");
      });
    };
    open();
    return () => {
      closed = true;
      es?.removeAllEventListeners();
      es?.close();
    };
  }, [path]);
}
