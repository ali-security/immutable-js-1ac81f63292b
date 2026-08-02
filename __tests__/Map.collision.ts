/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

///<reference path='../resources/jest.d.ts'/>
///<reference path='../dist/immutable.d.ts'/>

jest.autoMockOff();

import { Map, Set, fromJS, is } from 'immutable';

/**
 * Generates `2 ** rounds` distinct strings that all share the same
 * `Immutable.hash()`, by concatenating the classic "Aa"/"BB" collision blocks
 * (both equal `65 * 31 + 97 === 66 * 31 + 66 === 2112` under the JVM-style
 * `31 * h + c` string hash). Inserting these into a Map forces them all into a
 * single HashCollisionNode — the hash-flooding scenario this code guards.
 */
function collisionKeys(rounds: number): Array<string> {
  var keys = [''];
  for (var i = 0; i < rounds; i++) {
    var next: Array<string> = [];
    for (var j = 0; j < keys.length; j++) {
      next.push(keys[j] + 'Aa');
      next.push(keys[j] + 'BB');
    }
    keys = next;
  }
  return keys;
}

// `{ [key]: index }` for every key.
function objectOf(keys: Array<string>): any {
  var obj: any = {};
  for (var ii = 0; ii < keys.length; ii++) {
    obj[keys[ii]] = ii;
  }
  return obj;
}

// `[[key, index], ...]` for every key.
function entryPairs(keys: Array<string>): Array<Array<any>> {
  var pairs: Array<Array<any>> = [];
  for (var ii = 0; ii < keys.length; ii++) {
    pairs.push([keys[ii], ii]);
  }
  return pairs;
}

// Stands in for `new global.Set(values).size` — a native Set is neither
// available on every runtime this library supports nor importable here, where
// `Set` is the *Immutable* Set.
function countDistinct(values: Array<any>): number {
  var seen = Object.create(null);
  var count = 0;
  for (var ii = 0; ii < values.length; ii++) {
    if (seen[values[ii]] !== true) {
      seen[values[ii]] = true;
      count++;
    }
  }
  return count;
}

// immutable 3.8.3 does not export `hash()`, so the primary hash is observed
// through the Map's internal trie: every hash-routed node records the `hash()`
// of the key(s) it holds as `keyHash`.
function findKeyHash(node: any, key: any): any {
  if (!node) {
    return undefined;
  }
  if (node.entry) {
    return is(node.entry[0], key) ? node.keyHash : undefined;
  }
  if (node.entries) {
    for (var ii = 0; ii < node.entries.length; ii++) {
      if (is(node.entries[ii][0], key)) {
        return node.keyHash;
      }
    }
    return undefined;
  }
  for (var jj = 0; jj < node.nodes.length; jj++) {
    var found = findKeyHash(node.nodes[jj], key);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

// Reads back the public `hash()` of a single key.
function libHash(key: string): any {
  var obj: any = {};
  obj[key] = true;
  // More than MAX_ARRAY_MAP_SIZE (8) entries, so the flat leading node is
  // replaced by hash-routed nodes which record each key's `hash()`.
  for (var ii = 0; ii < 12; ii++) {
    obj['libHash-filler-' + ii] = ii;
  }
  return findKeyHash((Map<string, any>(obj) as any)._root, key);
}

// Every instance shares one hashCode, so they all pile into a single
// HashCollisionNode without ever being strings.
class Collider {
  public id: number;
  constructor(id: number) {
    this.id = id;
  }
  equals(other: any): boolean {
    return other instanceof Collider && other.id === this.id;
  }
  hashCode(): number {
    return 7; // force every instance into the same collision node
  }
}

describe('Map hash collisions', () => {

  it('the generated keys really do collide (test is meaningful)', () => {
    var keys = collisionKeys(8); // 256 keys
    var h = libHash(keys[0]);
    expect(keys.every(k => libHash(k) === h)).toBe(true);
    expect(countDistinct(keys)).toBe(keys.length); // all distinct

    // And the Map really does gather them into one HashCollisionNode: the trie
    // could not separate them, which is exactly what colliding hashes means.
    var root: any = (Map<string, any>(objectOf(keys)) as any)._root;
    expect(root.keyHash).toBe(h);
    expect(root.entries.length).toBe(keys.length);
  });

  it('does not change the public, deterministic hash() of strings', () => {
    // The secondary collision hash is internal and seeded; it must not leak
    // into the public hash().
    expect(libHash('a')).toBe(97);
    expect(libHash('immutable-js')).toBe(510203252);
  });

  describe('correctness with thousands of colliding keys', () => {
    var keys = collisionKeys(11); // 2048 keys, well above the index threshold

    it('stores and retrieves every colliding key (built from an object)', () => {
      var map = Map<string, any>(objectOf(keys));

      expect(map.size).toBe(keys.length);
      expect(keys.every((k, i) => map.get(k) === i)).toBe(true);
      expect(map.get('not-a-colliding-key', 'default')).toBe('default');
      expect(map.has(keys[0])).toBe(true);
      expect(map.has('not-a-colliding-key')).toBe(false);
    });

    it('behaves the same whether built transiently or persistently', () => {
      var transient = Map<string, any>().withMutations(m => {
        keys.forEach((k, i) => m.set(k, i));
      });
      var persistent = Map<string, any>();
      keys.forEach((k, i) => { persistent = persistent.set(k, i); });

      expect(transient.size).toBe(keys.length);
      expect(persistent.size).toBe(keys.length);
      expect(is(transient, persistent)).toBe(true);
      expect(keys.every((k, i) => persistent.get(k) === i)).toBe(true);
    });

    it('overwrites an existing colliding key without changing size', () => {
      var map = Map<string, any>(entryPairs(keys));
      var updated = map.set(keys[100], 9999);

      expect(updated.get(keys[100])).toBe(9999);
      expect(updated.size).toBe(map.size);
      // original is untouched (persistence)
      expect(map.get(keys[100])).toBe(100);
    });

    it('removes colliding keys and keeps the rest retrievable', () => {
      var map = Map<string, any>(entryPairs(keys));
      var removed = map.remove(keys[50]).remove(keys[51]).remove(keys[52]);

      expect(removed.size).toBe(map.size - 3);
      expect(removed.get(keys[50], 'gone')).toBe('gone');
      expect(removed.get(keys[51], 'gone')).toBe('gone');
      // a previously-removed-around key is still correct (index stayed valid)
      expect(removed.get(keys[53])).toBe(53);
      expect(removed.get(keys[0])).toBe(0);
      expect(removed.get(keys[keys.length - 1])).toBe(keys.length - 1);
    });

    it('iterates over every colliding entry exactly once', () => {
      var map = Map<string, any>(entryPairs(keys));

      var seen = Object.create(null);
      var seenCount = 0;
      map.forEach((v, k) => {
        if (seen[k] !== true) {
          seen[k] = true;
          seenCount++;
        }
      });
      expect(seenCount).toBe(keys.length);
      expect(keys.every(k => seen[k] === true)).toBe(true);

      expect(map.keySeq().toArray().sort()).toEqual(keys.slice().sort());
      expect(map.entrySeq().count()).toBe(keys.length);
    });

    it('keeps equals() and hashCode() consistent', () => {
      var a = Map<string, any>(entryPairs(keys));
      var b = Map<string, any>(entryPairs(keys));
      expect(is(a, b)).toBe(true);
      expect(a.hashCode()).toBe(b.hashCode());

      var c = a.set(keys[0], -1);
      expect(is(a, c)).toBe(false);
    });
  });

  it('mixes colliding and normally-distributed keys', () => {
    var keys = collisionKeys(10); // 1024 colliding
    var map = Map<string, any>(entryPairs(keys))
      .set('alpha', 'a')
      .set('beta', 'b');

    expect(map.get('alpha')).toBe('a');
    expect(map.get('beta')).toBe('b');
    expect(map.get(keys[7])).toBe(7);
    expect(map.size).toBe(keys.length + 2);
  });

  it('is correct just below and just above the index threshold', () => {
    // 8 keys (below threshold 16) then 64 keys (above) — both must be correct.
    var roundsToTry = [3, 6];
    for (var rr = 0; rr < roundsToTry.length; rr++) {
      var keys = collisionKeys(roundsToTry[rr]);
      var map = Map<string, any>();
      keys.forEach((k, i) => { map = map.set(k, i); });
      expect(map.size).toBe(keys.length);
      expect(keys.every((k, i) => map.get(k) === i)).toBe(true);

      // remove half, the rest must remain correct
      var trimmed = map;
      keys.slice(0, keys.length / 2).forEach(k => { trimmed = trimmed.remove(k); });
      expect(trimmed.size).toBe(keys.length / 2);
      expect(
        keys
          .slice(keys.length / 2)
          .every((k, i) => trimmed.get(k) === i + keys.length / 2)
      ).toBe(true);
    }
  });

  it('merge() and mergeDeep() work with colliding keys', () => {
    var keys = collisionKeys(11); // 2048 colliding
    var userObj = objectOf(keys);

    var merged = Map<string, any>({ existing: -1 }).merge(userObj);
    expect(merged.get('existing')).toBe(-1);
    expect(merged.get(keys[123])).toBe(123);
    expect(merged.size).toBe(keys.length + 1);

    var deep = Map<string, any>({ existing: -1 }).mergeDeep(fromJS(userObj));
    expect(deep.get(keys[123])).toBe(123);
    expect(deep.size).toBe(keys.length + 1);
  });

  it('Set (backed by Map) handles colliding values', () => {
    var keys = collisionKeys(11); // 2048 colliding
    var set = Set<string>(keys);

    expect(set.size).toBe(keys.length);
    expect(keys.every(k => set.has(k))).toBe(true);
    expect(set.has('not-in-set')).toBe(false);

    var without = set.remove(keys[10]);
    expect(without.has(keys[10])).toBe(false);
    expect(without.size).toBe(keys.length - 1);
  });

  it('handles value-object keys that all share one hashCode', () => {
    // Exercises the non-string fallback in hashCollisionKey: equality is still
    // decided by is()/equals(), never by the (constant) secondary hash.
    var items: Array<Collider> = [];
    for (var ii = 0; ii < 50; ii++) {
      items.push(new Collider(ii));
    }

    var map = Map<Collider, any>();
    items.forEach((c, i) => { map = map.set(c, i); });

    expect(map.size).toBe(items.length);
    expect(items.every((c, i) => map.get(new Collider(i)) === i)).toBe(true);
    expect(map.get(new Collider(999), 'absent')).toBe('absent');

    var removed = map.remove(new Collider(25));
    expect(removed.size).toBe(items.length - 1);
    expect(removed.get(new Collider(25), 'gone')).toBe('gone');
    expect(removed.get(new Collider(26))).toBe(26);
  });

  it('does not degrade for a large flood of colliding keys', () => {
    // A regression guard: with the linear scan this is ~O(n²) and takes seconds
    // for 16384 keys; with the seeded index it is ~linear and near-instant.
    var keys = collisionKeys(14); // 16384 colliding keys
    var map = Map<string, any>(objectOf(keys));

    expect(map.size).toBe(keys.length);
    // spot-check retrieval across the whole bucket
    expect(map.get(keys[0])).toBe(0);
    expect(map.get(keys[keys.length - 1])).toBe(keys.length - 1);
    expect(map.get(keys[keys.length >> 1])).toBe(keys.length >> 1);
  });

  it('stays near-linear against a hash flood (CWE-407 guard)', () => {
    // Same work, twice: once with keys crafted to share one hash() and once
    // with well-distributed keys. The linear scan makes the colliding case
    // ~O(n²) — hundreds of times slower — which is the denial of service.
    // The seeded secondary index keeps it within a small factor.
    var colliding = collisionKeys(14); // 16384 keys, all one hash bucket
    var distributed = colliding.map((k, i) => 'distributed-key-' + i);

    function buildAndRead(keys: Array<string>): number {
      var obj = objectOf(keys);
      var start = Date.now();
      var map = Map<string, any>(obj);
      for (var ii = 0; ii < keys.length; ii++) {
        map.get(keys[ii]);
      }
      return Date.now() - start;
    }

    // Warm up so JIT state is comparable, then measure.
    buildAndRead(distributed.slice(0, 1024));
    var baseline = Math.max(buildAndRead(distributed), 5);
    var flooded = buildAndRead(colliding);

    // Unpatched this ratio is in the hundreds (tens of seconds vs milliseconds);
    // patched it is a small single-digit factor. 200x leaves ample headroom for
    // slow/noisy CI while still failing loudly on the quadratic behaviour.
    expect(flooded / baseline).toBeLessThan(200);
  });
});
