import * as assert from 'assert';
import { buildSearchPattern, toGlob } from '../searchUtils';

suite('searchUtils', () => {
	test('toGlob handles empty input', () => {
		assert.strictEqual(toGlob(''), undefined);
		assert.strictEqual(toGlob(' , ,'), undefined);
		assert.strictEqual(toGlob(undefined), undefined);
	});

	test('toGlob keeps a single glob and trims it', () => {
		assert.strictEqual(toGlob(' **/*.ts '), '**/*.ts');
	});

	test('toGlob combines comma separated globs', () => {
		assert.strictEqual(toGlob('**/*.ts, src/**'), '{**/*.ts,src/**}');
	});

	test('toGlob does not split commas inside braces', () => {
		assert.strictEqual(toGlob('**/*.{ts,js}'), '**/*.{ts,js}');
		assert.strictEqual(toGlob('**/*.{ts,js}, docs/**'), '{**/*.{ts,js},docs/**}');
	});

	test('toGlob turns trailing slash into a folder glob', () => {
		assert.strictEqual(toGlob('src/'), 'src/**');
	});

	test('buildSearchPattern escapes plain text and is case-insensitive by default', () => {
		const re = buildSearchPattern('a.b')!;
		assert.ok(re.test('A.B.txt'));
		assert.ok(!re.test('axb'));
	});

	test('buildSearchPattern honours match case', () => {
		assert.ok(!buildSearchPattern('abc', { matchCase: true })!.test('ABC'));
	});

	test('buildSearchPattern whole word matches name with or without extension', () => {
		const re = buildSearchPattern('index', { matchWholeWord: true })!;
		assert.ok(re.test('index'));
		assert.ok(re.test('index.ts'));
		assert.ok(!re.test('reindex.ts'));
		assert.ok(!re.test('index2.ts'));
	});

	test('buildSearchPattern returns undefined for invalid regex', () => {
		assert.strictEqual(buildSearchPattern('(', { useRegex: true }), undefined);
		assert.ok(buildSearchPattern('^a.*\\.ts$', { useRegex: true })!.test('abc.ts'));
	});
});
