import type { ProcessController, ProcInfo } from '../../src/main/infra/process-controller.js';

export class FakeProcs implements ProcessController {
  running: ProcInfo[] = [];
  closesOnRequest = true;
  killed: number[] = [];
  launched: string[] = [];
  listGate: Promise<void> | null = null;
  // 설정하면 launch() 가 호출될 때 이 프로세스가 실제로 뜬 것처럼 running 에 추가된다 (기본값: 아무것도 뜨지 않음)
  startsOnLaunch: ProcInfo | undefined;

  async list() {
    if (this.listGate) await this.listGate;
    return [...this.running];
  }
  aliveCalls = 0;
  async alive(pids: number[]) {
    this.aliveCalls++;
    return this.running.map((p) => p.pid).filter((pid) => pids.includes(pid));
  }
  async closeGracefully(pids: number[]) {
    if (this.closesOnRequest) this.running = this.running.filter((p) => !pids.includes(p.pid));
  }
  async kill(pids: number[]) {
    this.killed.push(...pids);
    this.running = this.running.filter((p) => !pids.includes(p.pid));
  }
  async launch(aumid: string) {
    this.launched.push(aumid);
    if (this.startsOnLaunch) this.running.push(this.startsOnLaunch);
  }
}
