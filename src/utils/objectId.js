// mongoose.isValidObjectId also accepts any 12-character string (and numbers): too
// permissive for identifiers coming from tokens, headers or paths. Strict 24-hex check.
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

const isObjectIdString = (value) => typeof value === 'string' && OBJECT_ID_HEX.test(value);

module.exports = { isObjectIdString };
