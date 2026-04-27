export interface HeapItem {
  keyId: string;
  resetAt: number;
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
