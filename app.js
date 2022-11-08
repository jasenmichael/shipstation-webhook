const express = require('express')
const router = express.Router()
const compression = require('compression')

const isServerless = process.env.SERVERLESS

const { shipstation } = require('./webhooks')

const app = express()
app.use(compression())

app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(!isServerless ? '/' : '/.netlify/functions', router)

router.get('/webhooks', (req, res) => res.status(200).json({ message: 'ok' }))

// Route to receive the ShipStation New Order Webhook
router.post('/webhooks/shipstation/on-new-orders', async (req, res) => {
  if (req.query.token !== process.env.SHIPSTATION_WEBHOOK_TOKEN) {
    console.log(`🚫 ERROR - Shipstation webhook token does not match. Token: ${req.query.token}`) // eslint-disable-line
    return res.status(401).json('Unauthorized')
  } else {
    const response = await shipstation.onNewOrders(req, res)
    return res.status(200).json(response)
  }
})

if (isServerless) {
  module.exports = app
} else {
  module.exports = app.listen(process.env.PORT || 3005, () => console.log('App listening on port 3005!')) /* eslint-disable-line no-console */
}
