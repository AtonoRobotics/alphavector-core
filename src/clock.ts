export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FrozenClock implements Clock {
  constructor(private value: Date) {}
  now(): Date {
    return this.value;
  }
}
