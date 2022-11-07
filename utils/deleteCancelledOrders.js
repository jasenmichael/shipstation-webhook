/* eslint-disable no-console */
const shipstation = require('../providers/shipstation')

const getOrders = async (page = 1) => {
  const path = `/orders?orderStatus=cancelled&page=${page}`
  return (await shipstation.api(path)).data
}

const deleteAllCancelled = async () => {
  console.log('Deleting all cancelled orders...')
  const { orders, pages, page, total } = await getOrders()
  const orderIds = orders.map(order => order.orderId)
  console.log('total:', total)
  console.log('page:', page)
  console.log('pages:', pages)

  if (total > 0) {
    orderIds.forEach((orderId, i) => {
      try {
        console.log('deleting order:', orderId)
        setTimeout(async () => {
          const response = await shipstation.api(`/orders/${orderId}`, 'delete')
          console.log('response:', response.data)
        }, i * 500)
      } catch (error) {
        setTimeout(() => {
          deleteAllCancelled()
        }, 600)
      }
    })
  }
}

deleteAllCancelled()
