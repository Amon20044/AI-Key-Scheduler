export interface HeapItem {
  keyId: string;
  resetAt: number;
}

export interface ScoredHeapItem {
  id: string;
  score: number;
}

export class MinHeap {
  private readonly items: HeapItem[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): HeapItem | undefined {
    return this.items[0];
  }

  push(item: HeapItem): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): HeapItem | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last) {
      return first;
    }

    if (this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }

    return first;
  }

  private bubbleUp(index: number): void {
    let childIndex = index;
    while (childIndex > 0) {
      const parentIndex = Math.floor((childIndex - 1) / 2);
      if (this.items[parentIndex].resetAt <= this.items[childIndex].resetAt) {
        break;
      }

      this.swap(parentIndex, childIndex);
      childIndex = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    let parentIndex = index;
    while (true) {
      const leftIndex = parentIndex * 2 + 1;
      const rightIndex = leftIndex + 1;
      let smallestIndex = parentIndex;

      if (leftIndex < this.items.length && this.items[leftIndex].resetAt < this.items[smallestIndex].resetAt) {
        smallestIndex = leftIndex;
      }

      if (rightIndex < this.items.length && this.items[rightIndex].resetAt < this.items[smallestIndex].resetAt) {
        smallestIndex = rightIndex;
      }

      if (smallestIndex === parentIndex) {
        return;
      }

      this.swap(parentIndex, smallestIndex);
      parentIndex = smallestIndex;
    }
  }

  private swap(left: number, right: number): void {
    const item = this.items[left];
    this.items[left] = this.items[right];
    this.items[right] = item;
  }
}

export class MaxScoreHeap<T extends ScoredHeapItem> {
  private readonly items: T[] = [];
  private readonly indexById = new Map<string, number>();

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  pop(): T | undefined {
    const first = this.items[0];
    const last = this.items.pop();
    if (!first || !last) {
      if (first) {
        this.indexById.delete(first.id);
      }
      return first;
    }

    this.indexById.delete(first.id);
    if (this.items.length > 0) {
      this.items[0] = last;
      this.indexById.set(last.id, 0);
      this.bubbleDown(0);
    }

    return first;
  }

  upsert(item: T): void {
    const index = this.indexById.get(item.id);
    if (index === undefined) {
      this.items.push(item);
      const nextIndex = this.items.length - 1;
      this.indexById.set(item.id, nextIndex);
      this.bubbleUp(nextIndex);
      return;
    }

    this.items[index] = item;
    this.bubbleUp(index);
    this.bubbleDown(index);
  }

  private bubbleUp(index: number): void {
    let childIndex = index;
    while (childIndex > 0) {
      const parentIndex = Math.floor((childIndex - 1) / 2);
      if (this.items[parentIndex].score >= this.items[childIndex].score) {
        break;
      }

      this.swap(parentIndex, childIndex);
      childIndex = parentIndex;
    }
  }

  private bubbleDown(index: number): void {
    let parentIndex = index;
    while (true) {
      const leftIndex = parentIndex * 2 + 1;
      const rightIndex = leftIndex + 1;
      let largestIndex = parentIndex;

      if (leftIndex < this.items.length && this.items[leftIndex].score > this.items[largestIndex].score) {
        largestIndex = leftIndex;
      }

      if (rightIndex < this.items.length && this.items[rightIndex].score > this.items[largestIndex].score) {
        largestIndex = rightIndex;
      }

      if (largestIndex === parentIndex) {
        return;
      }

      this.swap(parentIndex, largestIndex);
      parentIndex = largestIndex;
    }
  }

  private swap(left: number, right: number): void {
    const leftItem = this.items[left];
    const rightItem = this.items[right];
    this.items[left] = rightItem;
    this.items[right] = leftItem;
    this.indexById.set(this.items[left].id, left);
    this.indexById.set(this.items[right].id, right);
  }
}
