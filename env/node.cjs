exports.PROD = process.env.NODE_ENV === "production";
exports.DEV = !exports.PROD;
exports.MODE = exports.PROD ? "production" : "development";
