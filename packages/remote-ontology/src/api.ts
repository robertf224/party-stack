// jjj

// Interface for an RPC transport, which is a simple bidirectional message stream.
export interface RpcTransport {
    // Sends a message to the other end.
    send(message: string): Promise<void>;

    // Receives a message sent by the other end.
    //
    // If and when the transport becomes disconnected, this will reject. The thrown error will be
    // propagated to all outstanding calls and future calls on any stubs associated with the session.
    // If there are no outstanding calls (and none are made in the future), then the error does not
    // propagate anywhere -- this is considered a "clean" shutdown.
    receive(): Promise<string>;

    // Indicates that the RPC system has suffered an error that prevents the session from continuing.
    // The transport should ideally try to send any queued messages if it can, and then close the
    // connection. (It's not strictly necessary to deliver queued messages, but the last message sent
    // before abort() is called is often an "abort" message, which communicates the error to the
    // peer, so if that is dropped, the peer may have less information about what happened.)
    abort?(reason: any): void;
}

// transports we'll def want:
// - WebView (MessagePort / MessageChannel)
// - HTTP / SSE

// Client?
interface Transport {
    // relay does execute: () => Observable(response) basically...
    // request/execute/call: (req payload) => response payload (w/ type params)
    // stream: (req payload) => response stream (w/ type params) (disposable)
}

// server fn?

// if we're just doing http/sse for subsets we just need to be able to do calls + do sse connections (so like "stream" w/ a payload)
// in any case we could prob stream query results w/ a websocket transport thingy??

// describe, applyAction, loadSubset, streamSubset (?),

// zero handles queries on server w/ desired set, and we send messages to patch that set
// alternatively could we just have a stream per query? conceptually that's what we're trying to get,
// even if it's over some bidirectional stream I think.  and we can prob abstract over that part
