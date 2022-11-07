/* eslint-disable no-console */
const axios = require('axios')
const axiosRetry = require('axios-retry')
require('dotenv').config()

let warehouses, users, defaultWarehouse

/**
 * ShipStation On New Order Webhook
 *
 * @param {object} req the request object
 *
 * @return {object} response object with
 */
const onNewOrders = async ({ body }) => {
  try {
    console.log('⌛ Shipstation new order webhook received ⌛')
    // Retrieve the URL from the ShipStation webhook.
    const { resource_url, resource_type } = body // eslint-disable-line camelcase
    if (!resource_url || !resource_type === 'ORDER_NOTIFY') { // eslint-disable-line camelcase
      const error = 'Shipstation new oder webhook FAILED: missing resource_url or resource_type'
      console.log('🚫 ERROR:', error)
      return { error }
    }

    // Pull the new orders
    const newOrders = (await api(resource_url)).data.orders
      .filter(order => order.orderStatus === 'awaiting_shipment') // only orders with status "awaiting_shipment"
      .filter(order => !order.advancedOptions.customField1.includes('webhook_processed')) // only orders that have not been processed by this webhook
      // .filter(order => order.advancedOptions.customField1.includes('vendor-split')) // only orders that need to be split

    if (newOrders.length) {
      // get the Shipstation warehouses
      warehouses = (await api('/warehouses')).data
      users = (await api('/users?showInactive=false')).data
      defaultWarehouse = warehouses.find(warehouse => warehouse.isDefault)

      console.log(' 📦 Shipstation Warehouses Found:', warehouses.map(w => w.warehouseName).join(', '))
      console.log(' 👥 Shipstation User Accounts Found:', users.map(u => u.name).join(', '))
      console.log(`  ${newOrders.length} new orders found`)

      // Loop through the new orders, update stuff, split if has multiple warehouses
      const newOrdersUpdated = []
      newOrders.forEach((order) => {
        const tmpOrder = { ...order } /* Create a copy of the original order object. */
        const splitOrders = orderSplit(tmpOrder, getOrderWarehouses(tmpOrder))

        /* Add each split order to newOrdersUpdated */
        splitOrders.forEach(order => newOrdersUpdated.push(orderUpdate(order)))
      })

      console.log(`  ${newOrdersUpdated.length} orders updated`)
      if (newOrdersUpdated.length) {
        // Update all orders in one api call
        const newOrdersUpdatedResponse = (await api('/orders/createorders', 'post', newOrdersUpdated)).data
        console.log(' 📦 Shipstation Orders Updated:', newOrdersUpdatedResponse.results.map(o => `${o.orderNumber}`).join(', '))

        if (!newOrdersUpdatedResponse.hasErrors) {
          /* ## ASIGN USERS TO ORDERS
           * Shipstation will not run automation on orders after they are added, unless you manually click "Reprocess Automation Rules" in the shipstaion ui.
           * We must assign the warehouse user to the order after it is created, therfore we must make another api call (per order) to assign the user.
           */
          console.log(' 👥 Assigning users to updated orders')
          await Promise.all(newOrdersUpdated.map(async (order) => {
            const assignUsersResults = []
            if (order.orderId && order.userId) {
              const assignUserResults = (await api('/orders/assignuser', 'post', { orderIds: [order.orderId], userId: order.userId })).data
              assignUsersResults.push(assignUserResults)
            }
            console.log(assignUsersResults.map(r => `    ${order.orderNumber} ${r.message}`).join('\r'))
          }))
        }
      }
    } else {
      console.log('  No new orders found')
    }

    const message = '🎉 Shipstation new order webhook succeeded! 🎉'
    console.log(message)
    return { message }
  } catch (error) {
    return { error }
  }
}

/**
 * Performs a ShipStation API Call
 *
 * @param {string} endpoint path or the full URL to the Shipstaion Api Url
 * @param {string} method generally "get" or "post"
 * @param {JSON} body the body of a POST request (if applicable)
 *
 * @return {JSON} the response from the API call
 */
const api = async (endpoint, method = 'get', body) => {
  const shipstaionApiUrl = process.env.SHIPSTATION_API_URL || 'https://ssapi.shipstation.com'
  const url = endpoint.includes('shipstation.com') ? endpoint : shipstaionApiUrl.replace(/\/$/, '') + endpoint
  try {
    const config = {
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${process.env.SHIPSTATION_API_KEY}`
      }
    }

    if (body && method.toLowerCase() === 'post') {
      config.data = JSON.stringify(body)
    }

    axiosRetry(axios, {
      retries: 3, // number of retries
      retryDelay: (retryCount) => {
        console.log(`retry attempt: ${retryCount}`)
        return retryCount * 2000 // time interval between retries
      }
    })

    return await axios(config)
  } catch (error) {
    throw new Error(error)
  }
}

module.exports = {
  onNewOrders,
  api
}

/* HELPERS */
/**
 * Gets the warehouses from the order
 *
 * @param {object} order the order object
 *
 * @return {array} array of warehouses that exist in order.items
 */
const getOrderWarehouses = order => [...new Set(order.items.map(item => item.options.find(opt => opt.name === 'vendor').value || null))]

/**
 * Splits an order object
 *
 * @param {object} order the order object to be split
 *
 * @return {array} an array of order objects
 */
const orderSplit = (order, orderWarehouses) => {
  /* If orderWarehouses contains defaultWarehouse, put defaultWarehouse first in the array.
   *
   * This is important because Shipstation only allows setting "ship from" on initial order creation (add by Shopify, or when split by this webhook),
   * for orders that need to be split, they get set to the default warehouse on creation
   * that way if the order is split, the default warehouse will be the first warehouse in the array,
   * and all split items will be newly created orders set with their warehouse
   */
  if (orderWarehouses.includes(defaultWarehouse.warehouseName)) {
    orderWarehouses = orderWarehouses.sort(a => a === defaultWarehouse.warehouseName ? -1 : 1)
  }

  return orderWarehouses.map((warehouse, i) => {
    const tmpOrderToSplit = { ...order }

    // filter only items with vendor-{warehouse}
    tmpOrderToSplit.items = tmpOrderToSplit.items.filter(item => item.options.find(opt => opt.name === 'vendor').value === warehouse)
    const orderNumber = tmpOrderToSplit.orderNumber.includes('-') ? tmpOrderToSplit.orderNumber.split('-')[0] : tmpOrderToSplit.orderNumber
    tmpOrderToSplit.orderNumber = `${orderNumber}-${warehouse}`
    tmpOrderToSplit.warehouseLocation = warehouse
    tmpOrderToSplit.advancedOptions.warehouseId = getWarehouseIdByWarehouseName(warehouse, warehouses)

    // If not the first order, we remove some fields so a new order is created.
    if (i !== 0) {
      delete tmpOrderToSplit.orderKey
      delete tmpOrderToSplit.orderId
      tmpOrderToSplit.amountPaid = 0
      tmpOrderToSplit.taxAmount = 0
      tmpOrderToSplit.shippingAmount = 0
    }

    return tmpOrderToSplit
  })
}

/**
 * Updates an order object
 *
 * @param {object} order the order object to be updated
 * @param {object} data additional order fields to be updated
 *
 * @return {object} the updated order object
 */
const orderUpdate = (order) => {
  const warehouseLocation = order.warehouseLocation || defaultWarehouse
  return {
    ...order,
    warehouseLocation,
    advancedOptions: {
      ...order.advancedOptions,
      warehouseId: getWarehouseIdByWarehouseName(warehouseLocation, warehouses),
      customField1: [...new Set((`webhook_processed, vendor-${warehouseLocation.toLowerCase()}, ` + order.advancedOptions.customField1)
        .replace(/vendor-split/g, 'order_split')
        .split(', '))].join(', ')
    },
    items: order.items.map(item => orderItemUpdate(item, { warehouseLocation })),
    userId: getUserIdByWarehouseName(warehouseLocation, users)
  }
}

/**
 * Updates an order item object
 *
 * @param {object} item the order item object to be updated
 * @param {object} data additional order item fields to be updated
 *
 * @return {object} the updated order item object
 */
const orderItemUpdate = (orderItem) => {
  const warehouseLocation = orderItem.options.find(opt => opt.name === 'vendor').value || defaultWarehouse
  return {
    ...orderItem,
    warehouseLocation,
    warehouseId: getWarehouseIdByWarehouseName(warehouseLocation, warehouses)
  }
}

/**
 * Gets the user id by warehouse name
 *
 * @param {string} warehouseName the warehouse name
 * @param {array} users an array of users
 *
 * @return {number} the warehouse id
 */
const getUserIdByWarehouseName = (warehouseName, users) => users.find(user => user.name === warehouseName).userId

/**
 * Gets the warehouse id by warehouse name
 *
 * @param {string} warehouseName the warehouse name
 * @param {array} warehouses an array of warehouses
 *
 * @return {number} the warehouse id
 */
const getWarehouseIdByWarehouseName = (warehouseName, warehouses) => warehouses.find(warehouse => warehouse.warehouseName === warehouseName).warehouseId
