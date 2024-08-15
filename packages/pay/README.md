# @apps-sdk/wechat-pay

微信支付v3接口。

已实现平台：

- 小程序

已实现功能

- 支付
- 回调通知

# 安装

```bash
pnpm add @apps-sdk/wechat-pay
```

# 小程序支付

## 1. 初始化

```typescript
import { MiniAppWeChatPay } from '@apps-sdk/wechat-pay';

const wepay = new MiniAppWeChatPay<Attach>({
  appid: '',
  mchid: '',
  cert: {
    file: '',
    seriesNo: '',
    secret: '',
  },
});

type Attach =
  | {
      type: 'business1';
      data1: {};
    }
  | {
      type: 'business2';
      data2: {};
    };
```

泛型为字段`attach`的类型约束，付款成功后可根据attach数据进行业务判断

## 2. 生成预定单

用户发起支付后，需要在服务端生成预定单，然后返回给前端

```typescript
router.post('/wepay/prepare', (request, response) => {
  const args = await wepay.generatePaymentArgs({
    description: '',
    notify_url: '',
    money: 100,
    openid: '',
    attach: {},
  });

  response.end(JSON.stringify(args));
});
```

客户端可根据args直接发起支付，并判断结果

```typescript
wx.request({
  url: 'http://api.com/wepay/prepare',
  method: 'POST',
  success: ({ data: args }) => {
    const result = await wx.requestPayment(args);
    if (result.errMsg.includes('ok')) {
      console.log('付款成功');
    }
  },
});
```

## 3. 支付回调

用户付款后，微信支付平台会以`POST`的方式发送异步回调，地址为生成预定单提供的`notify_url`。业务系统需要判断通知的真实性，然后再做业务处理

```typescript
router.post('/wepay/notify', async (request, response) => {
  const result = await wepay.verify(request);

  // 验证失败
  if (result === false) {
    response.statusCode = 403;
    response.end(JSON.stringify({ code: 'FAIL', message: '验证失败' }));
    return;
  }

  // 注意：通知可能多次发送，务必使用 transaction_id 或者 out_trade_no 对业务做去重判断

  if (result.trade_state === 'SUCCESS') {
    // 在这里处理支付成功后的业务，attach的类型为最开始介绍的Attach泛型
    console.log(result.attach);
  }

  // 必须响应，否则微信支付平台会再次发送通知
  response.statusCode = 204;
});
```
