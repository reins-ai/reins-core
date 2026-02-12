export interface StreamSubscriptionTarget {
  conversationId: string;
  assistantMessageId: string;
}

export interface StreamRegistrySocketData {
  connectionId: string;
}

export interface StreamRegistrySocket<TData extends StreamRegistrySocketData = StreamRegistrySocketData> {
  data: TData;
  send(message: string): unknown;
}

export function toStreamSubscriptionKey(target: StreamSubscriptionTarget): string {
  return `${target.conversationId}:${target.assistantMessageId}`;
}

export class WsStreamRegistry<TData extends StreamRegistrySocketData = StreamRegistrySocketData> {
  private readonly subscribersByStream = new Map<string, Map<string, StreamRegistrySocket<TData>>>();
  private readonly streamsByConnection = new Map<string, Set<string>>();
  private readonly socketsByConnection = new Map<string, StreamRegistrySocket<TData>>();

  subscribe(socket: StreamRegistrySocket<TData>, target: StreamSubscriptionTarget): string {
    const streamKey = toStreamSubscriptionKey(target);
    const connectionId = socket.data.connectionId;

    this.socketsByConnection.set(connectionId, socket);

    const subscribers = this.subscribersByStream.get(streamKey) ?? new Map<string, StreamRegistrySocket<TData>>();
    subscribers.set(connectionId, socket);
    this.subscribersByStream.set(streamKey, subscribers);

    const socketStreams = this.streamsByConnection.get(connectionId) ?? new Set<string>();
    socketStreams.add(streamKey);
    this.streamsByConnection.set(connectionId, socketStreams);

    return streamKey;
  }

  unsubscribe(socket: StreamRegistrySocket<TData>, target: StreamSubscriptionTarget): string {
    return this.unsubscribeByKey(socket.data.connectionId, toStreamSubscriptionKey(target));
  }

  removeConnection(socket: StreamRegistrySocket<TData>): void {
    const connectionId = socket.data.connectionId;
    const streamKeys = this.streamsByConnection.get(connectionId);
    if (streamKeys) {
      for (const streamKey of streamKeys) {
        this.removeSubscriber(streamKey, connectionId);
      }
    }

    this.streamsByConnection.delete(connectionId);
    this.socketsByConnection.delete(connectionId);
  }

  publish(target: StreamSubscriptionTarget, payload: unknown): number {
    const streamKey = toStreamSubscriptionKey(target);
    const subscribers = this.subscribersByStream.get(streamKey);
    if (!subscribers || subscribers.size === 0) {
      return 0;
    }

    const serialized = JSON.stringify(payload);
    let delivered = 0;
    const staleConnectionIds: string[] = [];

    for (const [connectionId, socket] of subscribers) {
      try {
        socket.send(serialized);
        delivered += 1;
      } catch {
        staleConnectionIds.push(connectionId);
      }
    }

    for (const connectionId of staleConnectionIds) {
      this.unsubscribeByKey(connectionId, streamKey);
      this.socketsByConnection.delete(connectionId);
    }

    return delivered;
  }

  clear(): void {
    this.subscribersByStream.clear();
    this.streamsByConnection.clear();
    this.socketsByConnection.clear();
  }

  forEachSocket(visitor: (socket: StreamRegistrySocket<TData>) => void): void {
    for (const socket of this.socketsByConnection.values()) {
      visitor(socket);
    }
  }

  getSubscriptionCount(target?: StreamSubscriptionTarget): number {
    if (target) {
      return this.subscribersByStream.get(toStreamSubscriptionKey(target))?.size ?? 0;
    }

    let count = 0;
    for (const subscribers of this.subscribersByStream.values()) {
      count += subscribers.size;
    }
    return count;
  }

  private unsubscribeByKey(connectionId: string, streamKey: string): string {
    this.removeSubscriber(streamKey, connectionId);

    const socketStreams = this.streamsByConnection.get(connectionId);
    if (socketStreams) {
      socketStreams.delete(streamKey);
      if (socketStreams.size === 0) {
        this.streamsByConnection.delete(connectionId);
      }
    }

    return streamKey;
  }

  private removeSubscriber(streamKey: string, connectionId: string): void {
    const subscribers = this.subscribersByStream.get(streamKey);
    if (!subscribers) {
      return;
    }

    subscribers.delete(connectionId);
    if (subscribers.size === 0) {
      this.subscribersByStream.delete(streamKey);
    }
  }
}
