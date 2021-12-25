## 功能
透過 bitfinex 提供的 Websocket API 自動進行網格交易。

## 設定檔
```json
{
    "max": 1.75, // 價格上限
    "min": 1, // 價格下限
    "fixedPoint": 2, // 計算網格價格時，計算至小數點第 N 位
    "weight": 0.015, // 每個網格的加權值
    "amount": 4, // 下單金額
    "symbol": "tIOTUSD" // 下單交易對
}
```

```json
{
    "apiKey": "aaaaaa",
    "apiSecret": "bbbbb"
}
```

## 版本
- V 0.1
  可以完成網格劃分，依現價開出正確的買賣單

## TODO
Websocket 執行一兩天後會進行沒有反應的狀態，問題待查
### Build
  docker build -t grid-trading . --no-cache

### Start
 docker run -d -it -v /share/Dev/side_project/grid-trading/log:/usr/src/applog --entrypoint "/bin/bash" grid-trading

### Get into docker
docker exec -it c7ecbb53bc54 /bin/bash

### Run demean
