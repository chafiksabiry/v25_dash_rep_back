const mongoose = require('mongoose');
const { isObjectIdString } = require('../src/utils/objectId');

describe('isObjectIdString', () => {
  test('accepts 24 hex characters only', () => {
    expect(isObjectIdString(String(new mongoose.Types.ObjectId()))).toBe(true);
    expect(isObjectIdString('abcdefghijkl')).toBe(false);
    // mongoose 8.24 accepts numbers and buffers (a JWT claim could be a number); we do not
    expect(mongoose.isValidObjectId(123456789012)).toBe(true);
    expect(isObjectIdString(123456789012)).toBe(false);
    expect(isObjectIdString('zzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
    expect(isObjectIdString(123456789012)).toBe(false);
    expect(isObjectIdString(null)).toBe(false);
    expect(isObjectIdString(undefined)).toBe(false);
    expect(isObjectIdString({})).toBe(false);
  });
});
