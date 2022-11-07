const express = require('express')
const router = express.Router()
const compression = require('compression')

const isServerless = process.env.SERVERLESS

const webhooks = require('./webhooks')

const app = express()
app.use(compression())

app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(!isServerless ? '/' : '/.netlify/functions', router)

router.get('/webhooks', (req, res) => res.status(200).json({ message: 'ok' }))

// Route to receive the ShipStation New Order Webhook
router.post('/webhooks/shipstation/on-new-orders', async (req, res) => {
  console.log(JSON.stringify(req.headers, null, 2)) // eslint-disable-line no-console
  console.log(JSON.stringify(req.body, null, 2)) // eslint-disable-line no-console
  // process.exit(0)
  const response = await webhooks.shipstation.onNewOrders(req, res)
  res.status(response?.error ? 500 : 200).json(response)
})

if (isServerless) {
  module.exports = app
} else {
  module.exports = app.listen(process.env.PORT || 3005, () => console.log('App listening on port 3005!')) /* eslint-disable-line no-console */
}
