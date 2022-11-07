const serverless = require('serverless-http')
const app = require('../../app.js')

exports.handler = serverless(app)
