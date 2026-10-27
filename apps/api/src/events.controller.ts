import { Controller, Header, MessageEvent, Query, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { JobsService } from "./jobs/jobs.service";

@Controller()
export class EventsController {
  constructor(private readonly jobs: JobsService) {}

  @Sse("events")
  @Header("Cache-Control", "no-cache, no-transform")
  @Header("X-Accel-Buffering", "no")
  events(@Query("clientId") clientId = "acme"): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let lastPayload = "";

      const tick = async () => {
        if (closed) {
          return;
        }
        try {
          const snapshot = await this.jobs.snapshot(clientId);
          const payload = JSON.stringify(snapshot);
          if (payload !== lastPayload) {
            lastPayload = payload;
            subscriber.next({ type: "snapshot", data: snapshot });
          }
        } catch (error) {
          subscriber.next({
            type: "problem",
            data: { message: (error as Error).message, at: new Date().toISOString() },
          });
        }
      };

      void tick();
      const poll = setInterval(() => void tick(), 700);
      const heartbeat = setInterval(() => {
        if (!closed) {
          subscriber.next({ type: "ping", data: { at: Date.now() } });
        }
      }, 15000);

      return () => {
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
      };
    });
  }
}
