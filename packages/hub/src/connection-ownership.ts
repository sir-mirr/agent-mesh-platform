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
  private nextGeneration = 0;
  private readonly generations = new WeakMap<Socket, number>();
  private readonly identities = new WeakMap<Socket, string>();
  private readonly owners = new Map<string, Socket>();

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
