import { resolveLocations } from '../src/location-resolver.js';
import assert from 'assert';

console.log('Running Location Resolver Tests...');

try {
    // Test 1: Exact matches
    {
        console.log('Test 1: Exact matches...');
        const inputs = ['Goa', 'mumbai', 'DELHI'];
        const resolved = resolveLocations(inputs);
        assert(resolved.includes('Goa'), 'Should contain Goa');
        assert(resolved.includes('Mumbai'), 'Should contain Mumbai');
        assert(resolved.includes('Delhi'), 'Should contain Delhi');
        assert.strictEqual(resolved.length, 3, 'Should have 3 results');
        console.log('  PASS');
    }

    // Test 2: Fuzzy matches
    {
        console.log('Test 2: Fuzzy matches...');
        const inputs = ['gao', 'albag', 'lonavla'];
        const resolved = resolveLocations(inputs);
        assert(resolved.includes('Goa'), 'gao -> Goa');
        assert(resolved.includes('Alibaug'), 'albag -> Alibaug');
        assert(resolved.includes('Lonavala'), 'lonavla -> Lonavala');
        console.log('  PASS');
    }

    // Test 3: Aliases / Fuzzy
    {
        console.log('Test 3: Alias/Fuzzy (North Goa)...');
        const inputs = ['Goa North'];
        const resolved = resolveLocations(inputs);
        // Based on my logic, this should match "Goa - North" if distance is close enough
        assert(resolved.includes('Goa - North'), 'Goa North -> Goa - North');
        console.log('  PASS');
    }

    // Test 3b: CSV Input
    {
        console.log('Test 3b: CSV Input (Goa, Alibaug)...');
        const inputs = ['Goa, Alibaug'];
        const resolved = resolveLocations(inputs);
        assert(resolved.includes('Goa'), 'Should contain Goa');
        assert(resolved.includes('Alibaug'), 'Should contain Alibaug');
        assert.strictEqual(resolved.length, 2, 'Should have 2 results');
        console.log('  PASS');
    }

    // Test 4: Empty input
    {
        console.log('Test 4: Empty input...');
        assert.deepStrictEqual(resolveLocations([]), []);
        // assert.deepStrictEqual(resolveLocations(undefined), []); // undefined check might need strict TS check or run JS
        console.log('  PASS');
    }

    // Test 5: Deduplication
    {
        console.log('Test 5: Deduplication...');
        const inputs = ['Goa', 'gao', 'GOA'];
        const resolved = resolveLocations(inputs);
        assert.deepStrictEqual(resolved, ['Goa']);
        console.log('  PASS');
    }

    // Test 6: Unresolvable
    {
        console.log('Test 6: Unresolvable...');
        const inputs = ['Xyzzzzzzzzz'];
        const resolved = resolveLocations(inputs);
        assert.deepStrictEqual(resolved, []);
        console.log('  PASS');
    }

    console.log('\nAll tests passed successfully!');

} catch (error) {
    console.error('\nTEST FAILED:', error);
    process.exit(1);
}
