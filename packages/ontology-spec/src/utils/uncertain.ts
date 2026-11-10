export type Uncertain<T> =
    | {
          certain: true;
          value: T;
      }
    | {
          certain: false;
      };

export function certain<T>(value: T): Uncertain<T> {
    return {
        certain: true,
        value,
    };
}

export function uncertain<T>(): Uncertain<T> {
    return {
        certain: false,
    };
}
