export type Comparator<V> = (a: V, b: V) => number;

export class SortedObjectArray<K, V> {
    #data: V[];
    #key: (value: V) => K;
    #comparator: Comparator<V>;

    constructor(data: V[], key: (value: V) => K, comparator: Comparator<V>) {
        this.#data = data;
        this.#key = key;
        this.#comparator = comparator;
    }

    get = (key: K): V | undefined => {
        return this.#data.find((e) => this.#key(e) === key);
    };

    add = (value: V): void => {
        const key = this.#key(value);
        this.delete(key);
        const insertionIndex = this.findInsertionIndex(value);
        this.#data.splice(insertionIndex, 0, value);
    };

    delete = (key: K): boolean => {
        const index = this.#data.findIndex((e) => this.#key(e) === key);
        if (index !== -1) {
            this.#data.splice(index, 1);
            return true;
        } else {
            return false;
        }
    };

    findInsertionIndex = (value: V): number => {
        if (this.#data.length === 0 || this.#comparator(value, this.#data[0]!) < 0) {
            return 0;
        }

        if (this.#comparator(value, this.#data[this.#data.length - 1]!) >= 0) {
            return this.#data.length;
        }

        for (let index = 0; index < this.#data.length - 1; index++) {
            if (
                this.#comparator(value, this.#data[index]!) >= 0 &&
                this.#comparator(value, this.#data[index + 1]!) < 0
            ) {
                return index + 1;
            }
        }

        throw new Error("Unreachable code.");
    };

    get data(): V[] {
        return this.#data;
    }
}
