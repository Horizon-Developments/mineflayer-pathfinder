class BinaryHeapOpenSet {
  constructor () {
    // Initialing the array heap and adding a dummy element at index 0
    this.heap = [null]
    // node -> index in this.heap, kept in sync on every swap so update()
    // doesn't need to indexOf() (O(n)) to find where a node currently sits.
    this.indices = new Map()
  }

  size () {
    return this.heap.length - 1
  }

  isEmpty () {
    return this.heap.length === 1
  }

  _swap (i, j) {
    [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]]
    this.indices.set(this.heap[i], i)
    this.indices.set(this.heap[j], j)
  }

  push (val) {
    // Inserting the new node at the end of the heap array
    this.heap.push(val)

    // Finding the correct position for the new node
    let current = this.heap.length - 1
    this.indices.set(val, current)
    let parent = current >>> 1

    // Traversing up the parent node until the current node is greater than the parent
    while (current > 1 && this.heap[parent].f > this.heap[current].f) {
      this._swap(parent, current)
      current = parent
      parent = current >>> 1
    }
  }

  update (val) {
    let current = this.indices.get(val)
    let parent = current >>> 1

    // Traversing up the parent node until the current node is greater than the parent
    while (current > 1 && this.heap[parent].f > this.heap[current].f) {
      this._swap(parent, current)
      current = parent
      parent = current >>> 1
    }
  }

  pop () {
    // Smallest element is at the index 1 in the heap array
    const smallest = this.heap[1]
    this.indices.delete(smallest)

    this.heap[1] = this.heap[this.heap.length - 1]
    this.heap.splice(this.heap.length - 1)

    const size = this.heap.length - 1

    if (size < 2) {
      if (size === 1) this.indices.set(this.heap[1], 1)
      return smallest
    }

    this.indices.set(this.heap[1], 1)

    const val = this.heap[1]
    let index = 1
    let smallerChild = 2
    const cost = val.f
    do {
      let smallerChildNode = this.heap[smallerChild]
      if (smallerChild < size) {
        const rightChildNode = this.heap[smallerChild + 1]
        if (smallerChildNode.f > rightChildNode.f) {
          smallerChild++
          smallerChildNode = rightChildNode
        }
      }
      if (cost <= smallerChildNode.f) {
        break
      }
      this.heap[index] = smallerChildNode
      this.indices.set(smallerChildNode, index)
      this.heap[smallerChild] = val
      this.indices.set(val, smallerChild)
      index = smallerChild

      smallerChild *= 2
    } while (smallerChild <= size)

    return smallest
  }
}

module.exports = BinaryHeapOpenSet
