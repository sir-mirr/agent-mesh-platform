export interface OwnershipGranted {
  ok: true;
  generation: number;
}

export interface OwnershipConflict {
  ok: false;
  incumbentGeneration: number;
  contenderGeneration: number;
}

/**
 * First established connection owns an identity until it closes. A contender
 * never replaces that owner; release only removes the socket if it is still
 * the current owner, which makes incumbent-close races safe.
 */
export class ConnectionOwnership<Socket extends object> {
  private nextGeneration: number;
  private readonly generations: WeakMap<Socket, number>;
  private readonly identities: WeakMap<Socket, string>;
  private readonly owners: Map<string, Socket>;

  /**
   * Written out rather than left to field initialisers, because of what the
   * coverage report does with the difference.
   *
   * A class with no explicit constructor still gets one, and it runs on every
   * `new` — but bun's lcov counts it as a function and never marks it hit.
   * Measured on 1.3.13: fields and one method with no constructor reports
   * `FNF:2 FNH:1`; the same class with the constructor written out reports
   * `FNF:2 FNH:2`. This was the last uncovered function in the file and it was
   * being attributed to code nobody could reach, which is the opposite of what
   * the number is for. It is also the only class in the counted source without
   * one, so the whole artefact costs exactly this.
   */
  constructor() {
    this.nextGeneration = 0;
    this.generations = new WeakMap();
    this.identities = new WeakMap();
    this.owners = new Map();
  }

  claim(identity: string, socket: Socket): OwnershipGranted | OwnershipConflict {
    const contenderGeneration = this.generationOf(socket);
    const incumbent = this.owners.get(identity);
    if (incumbent && incumbent !== socket) {
      return {
        ok: false,
        incumbentGeneration: this.generationOf(incumbent),
        contenderGeneration,
      };
    }
    this.owners.set(identity, socket);
    this.identities.set(socket, identity);
    return { ok: true, generation: contenderGeneration };
  }

  release(socket: Socket): { identity: string; wasOwner: boolean } | null {
    const identity = this.identities.get(socket);
    if (!identity) return null;
    const wasOwner = this.owners.get(identity) === socket;
    if (wasOwner) this.owners.delete(identity);
    this.identities.delete(socket);
    return { identity, wasOwner };
  }

  owner(identity: string): Socket | undefined {
    return this.owners.get(identity);
  }

  generationOf(socket: Socket): number {
    const known = this.generations.get(socket);
    if (known) return known;
    const generation = ++this.nextGeneration;
    this.generations.set(socket, generation);
    return generation;
  }
}
