/**
 * "Do it with Timmy": a task handed to Ask. A new conversation starts with the person's request, and the server is
 * told which task it is for, so Timmy reads the email the task came from and prepares what it needs (a reply, an
 * email, a meeting). Anything that reaches someone waits for the person's OK, and once it goes out the task is ticked
 * off (server/src/agent/tools.ts and gateway/screens.ts). Real workspaces only: the sample demo's Ask is scripted.
 */
import type { Task } from '../data/ws-types';
import { assistant } from './conversations';

export const doWithTimmyLabel = 'Do it with Timmy';

export function doWithTimmy(task: Task) {
  void assistant.ask(`Do my task “${task.title}”. Do what you can, and tell me what’s left for me.`, 'Tasks', { task: task.id });
}
