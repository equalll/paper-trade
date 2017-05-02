import express from 'express'
import Config from '../config'
import JPush from 'jpush-sdk'
import amqp from 'amqplib'
import moment from 'moment-timezone'
import singleton from '../common/singleton'
import StockRef from '../getSinaData/stocksRef'
import sqlstr from '../common/sqlStr'
import deal from './deal'
const { mainDB, redisClient, jpushClient } = singleton
var stocksRef = new StockRef()
var orders = new Map()
async function getAllOrder() {
    stocksRef.clear()
    orders.clear()
    let [os] = await mainDB.query("select o.*,a.CommissionLimit,a.CommissionRate from wf_street_practice_order o left join wf_street_practice_account a on o.AccountNo=a.AccountNo where execType=0")
    for (let order of os) {
        stocksRef.addSymbol(Config.getQueryName(order))
    }
}
//除权
async function sendStock({ rate, SecuritiesType, SecuritiesNo, time }) {
    let lastPrice = await singleton.getLastPrice(Config.getQueryName({ SecuritiesType, SecuritiesNo }))
    let [result] = await mainDB.query("select * from wf_street_practice_positionshistory where Id in (select max(Id) from wf_street_practice_positionshistory where SecuritiesNo=:SecuritiesNo and SecuritiesType=:SecuritiesType and CreateTime <:time group by AccountNO)", { replacements: { SecuritiesType, SecuritiesNo, time } })
    if (result.length) {
        let transaction = await mainDB.transaction();
        try {
            let t = { transaction }
            for (let p of result) {
                let { Positions: beforeSendPos, AccountNo, SecuritiesType, SecuritiesNo } = p
                let addP = beforeSendPos * rate
                let { Positions = 0, CostPrice, MemberCode } = await singleton.selectMainDB0("wf_street_practice_positions", { AccountNo, SecuritiesType, SecuritiesNo })
                if (Positions == 0) {
                    CostPrice = lastPrice[4]
                    await singleton.insertMainDB("wf_street_practice_positions", { Positions: addP, CostPrice, SecuritiesType, SecuritiesNo, MemberCode, AccountNo }, { CreateTime: "now()" }, t)
                    await singleton.insertMainDB("wf_street_practice_positionshistory", { MemberCode, AccountNo, OldPositions: Positions, Positions: addP, SecuritiesType, SecuritiesNo, Reason: 1 }, { CreateTime: "now()" }, t)
                } else {
                    CostPrice = CostPrice / (1 + addP / (Positions + addP))
                    await singleton.updateMainDB("wf_street_practice_positions", { Positions: Positions + addP, CostPrice }, null, { AccountNo, SecuritiesType, SecuritiesNo }, t)
                    await singleton.insertMainDB("wf_street_practice_positionshistory", { MemberCode, AccountNo, OldPositions: Positions, Positions: Positions + addP, SecuritiesType, SecuritiesNo, Reason: 1 }, { CreateTime: "now()" }, t)
                }
            }
            await transaction.commit()
        } catch (ex) {
            console.error(ex)
            await transaction.rollback()
        }
    }
}
//除息
async function bonus({ rate, SecuritiesType, SecuritiesNo, time }) {
    let [result] = await mainDB.query("select * from wf_street_practice_positionshistory where Id in (select max(Id) from wf_street_practice_positionshistory where SecuritiesNo=:SecuritiesNo and SecuritiesType=:SecuritiesType and CreateTime <:time group by AccountNO)", { replacements: { SecuritiesType, SecuritiesNo, time } })
    if (result.length) {
        let transaction = await mainDB.transaction();
        try {
            let t = { transaction }
            for (let p of result) {
                let { Positions: beforeSendPos, AccountNo, SecuritiesType, SecuritiesNo, MemberCode } = p
                let addCash = beforeSendPos * rate
                let { Cash } = await singleton.selectMainDB0("wf_street_practice_account", { AccountNo }, null, t)
                await singleton.updateMainDB("wf_street_practice_account", { Cash: Cash + addCash }, null, { AccountNo }, t)
                await singleton.insertMainDB("wf_street_practice_cashhistory", { MemberCode, AccountNo, OldCash: Cash, Cash: Cash + addCash, Reason: 1 }, { CreateTime: "now()" }, t)
            }
            await transaction.commit()
        } catch (ex) {
            console.error(ex)
            await transaction.rollback()
        }
    }
}
//rabitmq 通讯
async function startMQ() {
    var amqpConnection = await amqp.connect(Config.amqpConn)
    let channel = await amqpConnection.createChannel()
    let ok = await channel.assertQueue('paperTrade')
    await getAllOrder()
    channel.sendToQueue("getSinaData", new Buffer(JSON.stringify({ type: "reset", listener: "paperTrade", symbols: stocksRef.array })))
    channel.consume('paperTrade', msg => {
        let { cmd, data } = JSON.parse(msg.content.toString())
        switch (cmd) {
            case "create":
                if (!orders.has(data.Id)) {
                    let name = Config.getQueryName(data)
                    orders.set(data.Id, data)
                    if (stocksRef.addSymbol(name)) {
                        channel.sendToQueue("getSinaData", new Buffer(JSON.stringify({ type: "add", listener: "paperTrade", symbols: [name] })))
                    }
                }
                break;
            case "cancel":
                if (orders.has(data)) {
                    let name = Config.getQueryName(orders.get(data))
                    if (stocksRef.removeSymbol(name))
                        channel.sendToQueue("getSinaData", new Buffer(JSON.stringify({ type: "remove", listener: "paperTrade", symbols: [name] })))
                }
                break;
            case "sendStock": //派股
                sendStock(data)
                break;
            case "bonus": //分红
                bonus(data)
                break;
        }
    })
    await channel.assertExchange("broadcast", "fanout");
    ok = await channel.assertQueue('sinaData_paperTrade');
    ok = await channel.bindQueue('sinaData_paperTrade', 'broadcast', 'fanout');
    channel.consume('sinaData_paperTrade', msg => {
        switch (msg.content.toString()) {
            case "restart": //股票引擎重启信号
                channel.sendToQueue("getSinaData", new Buffer(JSON.stringify({ type: "reset", listener: "paperTrade", symbols: stocksRef.array })))
                break;
        }
        channel.ack(msg)
    })
}
startMQ()

async function sendNotify(order) {
    let JpushRegID = (await mainDB.query('select JpushRegID from wf_im_jpush where MemberCode=:MemberCode', { replacements: order }))[0][0].JpushRegID;
    let SecuritiesName = (await mainDB.query('select SecuritiesName from wf_securities_trade where SecuritiesNo =:SecuritiesNo and SecuritiesType = :SecuritiesType', { replacements: order }))[0][0].SecuritiesName
    jpushClient.push().setPlatform(JPush.ALL).setAudience(JPush.registration_id(JpushRegID))
        //sendno, time_to_live, override_msg_id, apns_production, big_push_duration
        .setOptions(null, null, null, Config.apns_production)
        .setNotification('成交提醒', JPush.ios(msg, 'sound', 0, false, { AlertType: Config.jpushType_paperTrade, SecuritiesName, order }), JPush.android(msg, title, 1, { AlertType: Config.jpushType, SecuritiesName, order }))
        .send(async(err, res) => {
            if (err) {
                if (err instanceof JPush.APIConnectionError) {
                    console.log(err.message)
                } else if (err instanceof JPush.APIRequestError) {
                    console.log(err.message)
                }
            } else {

            }
        })
}
setInterval(async() => {
    let marketIsOpen = await singleton.marketIsOpen()
    for (let order of orders.values()) {
        //拒绝超时订单
        if (new Date(order.EndTime) > new Date()) {
            let { Id } = order
            await mainDB.query(...sqlstr.update2("wf_street_practice_order", { execType: 3, Reason: 3 }, null, { Id }))
            orders.delete(Id)
            continue
        }
        //未开盘则直接跳过
        if (!marketIsOpen[order.SecuritiesType]) {
            continue
        }
        let name = Config.getQueryName(order)
        let { AccountNo, OrdType, Side, OrderQty, Price, SecuritiesType, SecuritiesNo, CommissionRate, CommissionLimit } = order
        let [, , , price, pre, chg] = await singleton.getLastPrice(name)
        let Commission = Math.max(CommissionRate * OrderQty, CommissionLimit) //佣金
        let delta = Side == "B" ? -Commission - price * OrderQty : price * OrderQty - Commission
        if (OrdType == 1 || (Side == "BS" [OrdType - 2] ? (Price > price) : (Price < price))) {
            let x = Object.assign(Object.assign({ delta }, order), { Commission, Price: price })
            let result = await deal(x)
            if (result === 0) {
                sendNotify(order)
                    //处理完毕
                orders.delete(order.Id)
            } else {
                console.log(new Date(), result)
            }
        }
    }
}, 10000)