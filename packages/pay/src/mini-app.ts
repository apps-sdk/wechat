import dayjs from 'dayjs';
import axios, { type AxiosInstance } from 'foca-axios';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import getRawBody from 'raw-body';

export interface MiniAppWeChatPayOptions {
  /**
   * 小程序的 appid，可在微信开发者工具中查看
   */
  appid: string;
  /**
   * 商户号ID，需要登录微信支付平台查看
   */
  mchid: string;
  /**
   * 微信支付平台生成的商户证书
   * @link https://pay.weixin.qq.com/index.php/core/cert/api_cert
   */
  cert: {
    /**
     * 证书私钥文件（需下载客户端生成），文件的内容以 `-----BEGIN PRIVATE KEY-----` 开头
     */
    file: string;
    /**
     * 证书序列号
     */
    seriesNo: string;
    /**
     * APIv3密钥，长度32位
     */
    secret: string;
  };
  /**
   * 商户系统内部订单号，只能是数字、大小写字母_-*且在同一个商户号下唯一，长度：6-32
   */
  generateTradeNO?: () => string;
}

/**
 * 小程序支付服务，支持证书版本：v3
 */
export class MiniAppWeChatPay<Attach extends object = object> {
  protected readonly cert: string;
  protected readonly httpClient: AxiosInstance;

  constructor(protected readonly config: MiniAppWeChatPayOptions) {
    this.cert = readFileSync(config.cert.file, { encoding: 'utf8' });
    this.httpClient = axios.create();
    this.httpClient.interceptors.response.use(
      (result) => {
        if (result.data.errcode) {
          throw new Error(result.data.errmsg);
        }
        return result;
      },
      (err) => {
        throw new Error(err.response?.data?.message || err.response?.data || err.message);
      },
    );
  }

  /**
   * 在微信支付服务后台生成预支付交易单
   * @link https://pay.weixin.qq.com/docs/merchant/apis/mini-program-payment/mini-prepay.html
   */
  async prepay(data: {
    /**
     * 订单描述
     */
    description: string;
    /**
     * 异步接收微信支付结果通知的回调地址，通知URL必须为外网可访问的URL，不能携带参数。公网域名必须为HTTPS
     */
    notify_url: string;
    /**
     * 订单金额（人民币），单位为`分`
     */
    money: number;
    /**
     * 用户的openid，小程序环境下可直接获取
     */
    openid: string;
    /**
     * 自定义的信息，支付完成后原样返回，用于业务判断
     */
    attach: Attach;
    /**
     * 付款过期时间。默认值：`1天`
     */
    expire_time?: Date;
  }) {
    const tradeNo = (this.config.generateTradeNO || this.generateTradeNO)();
    const body = {
      appid: this.config.appid,
      mchid: this.config.mchid,
      description: data.description,
      out_trade_no: tradeNo,
      time_expire: data.expire_time || dayjs().add(1, 'day').toISOString(),
      notify_url: data.notify_url,
      attach: JSON.stringify(data.attach),
      amount: {
        total: data.money,
        currency: 'CNY',
      },
      payer: {
        openid: data.openid,
      },
    };

    const url = 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi';
    const authorization = this.generateToken({
      url,
      method: 'POST',
      body: JSON.stringify(body),
    });

    const { prepay_id } = await this.httpClient.post<{ prepay_id: string }>(url, body, {
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    const payload = {
      timeStamp: dayjs().unix().toString(),
      nonceStr: nanoid(26),
      package: 'prepay_id=' + prepay_id,
      signType: 'RSA',
    };
    return {
      ...payload,
      paySign: this.sha256WithRsa(
        `${this.config.appid}\n${payload.timeStamp}\n${payload.nonceStr}\n${payload.package}\n`,
        this.cert,
      ),
    };
  }

  /**
   * 付款完成后的通知验证。
   * - 验证失败则返回 `false`，需响应5XX或4XX状态码
   * - 验证成功则返回正常数据，需响应200或204状态码
   *
   * @param rawBody 如果提前解析过body，则再次解析会出错(stream is not readable)，此时需要手动传入
   *
   * @link https://pay.weixin.qq.com/docs/merchant/development/interface-rules/signature-verification.html
   */
  async verify(request: IncomingMessage, rawBody?: string) {
    const {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-serial': serial,
      'wechatpay-signature': signature,
    } = request.headers;
    rawBody ??= await getRawBody(request, { encoding: 'utf-8' });
    const certs = await this.getWepayPublicKeys({
      method: 'GET',
      url: 'https://api.mch.weixin.qq.com/v3/certificates',
      body: '',
    });
    const trusted = crypto
      .createVerify('sha256WithRSAEncryption')
      .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
      .verify(certs[String(serial)]!, String(signature), 'base64');
    return trusted && this.parseNotifyData(rawBody);
  }

  protected parseNotifyData(rawBody: string) {
    const { resource } = JSON.parse(rawBody) as {
      id: string;
      resource: { ciphertext: string; nonce: string; associated_data: string };
    };
    const result = this.decodeCipherText<WeChatPayNotifyResult<Attach>>(resource);
    if (result.trade_state === 'SUCCESS') {
      result.attach = JSON.parse(result.attach as unknown as string);
    }
    return result;
  }

  /**
   * 获取商户当前可用的平台证书列表（非商户证书）
   *
   * @link https://pay.weixin.qq.com/docs/merchant/apis/platform-certificate/api-v3-get-certificates/get.html
   */
  protected async getWepayPublicKeys(data: {
    method: 'GET' | 'POST';
    url: string;
    body: string;
  }) {
    const authorization = this.generateToken(data);
    const result = await this.httpClient.get<{
      data: {
        encrypt_certificate: {
          ciphertext: string;
          nonce: string;
          associated_data: string;
        };
      }[];
    }>('https://api.mch.weixin.qq.com/v3/certificates', {
      cache: {
        maxAge: 12 * 3600_000,
        format(formatConfig) {
          return { url: formatConfig.url };
        },
      },
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    const certs: Record<string, string> = {};
    result.data.forEach(({ encrypt_certificate }) => {
      const publicKey = this.decodeCipherText(encrypt_certificate);
      const seriesNo = new crypto.X509Certificate(publicKey).serialNumber;
      certs[seriesNo] = publicKey;
    });

    return certs;
  }

  protected decodeCipherText<T = string>(data: {
    ciphertext: string;
    nonce: string;
    associated_data: string;
  }): T {
    const cipherText = Buffer.from(data.ciphertext, 'base64');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.config.cert.secret,
      data.nonce,
    );
    decipher.setAuthTag(cipherText.subarray(cipherText.length - 16));
    decipher.setAAD(Buffer.from(data.associated_data));
    const decoded = decipher.update(
      cipherText.subarray(0, cipherText.length - 16),
      undefined,
      'utf8',
    );
    decipher.final();

    try {
      return JSON.parse(decoded) as T;
    } catch (e) {
      return decoded as T;
    }
  }

  /**
   *
   * 商户系统内部订单号，只能是数字、大小写字母_-*且在同一个商户号下唯一，长度：6-32
   */
  protected generateTradeNO() {
    return (
      'NO_' +
      Math.round(Math.random() * 10000) +
      Date.now() +
      Math.round(Math.random() * 10000000)
    );
  }

  protected sha256WithRsa(content: string, cert: string) {
    return crypto.createSign('RSA-SHA256').update(content, 'utf-8').sign(cert, 'base64');
  }

  protected generateToken(data: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    body: string;
  }) {
    const url = new URL(data.url);
    const timestamp = dayjs().unix();
    const nonce = nanoid(32);
    const content = `${data.method}\n${url.pathname + url.search}\n${timestamp}\n${nonce}\n${
      data.body
    }\n`;

    const signature = this.sha256WithRsa(content, this.cert);
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchid}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.cert.seriesNo}",signature="${signature}"`;

    return authorization;
  }
}

export type WeChatPayNotifyResult<Attach extends object = object> = {
  appid: string;
  mchid: string;
  /**
   * 商户系统内部订单号
   */
  out_trade_no: string;
  /**
   * 微信支付系统生成的订单号。
   */
  transaction_id: string;
  /**
   * - JSAPI：公众号支付
   * - NATIVE：扫码支付
   * - App：App支付
   * - MICROPAY：付款码支付
   * - MWEB：H5支付
   * - FACEPAY：刷脸支付
   */
  trade_type: 'JSAPI' | 'NATIVE' | 'App' | 'MICROPAY' | 'MWEB' | 'FACEPAY';
  trade_state_desc: string;
  bank_type: string;
  /**
   * 支付完成时间
   */
  success_time: string;
  payer: {
    openid: string;
  };
  amount: {
    /**
     * 订单总金额，单位为分。
     */
    total: number;
    /**
     * 用户支付金额，单位为分。
     */
    payer_total: number;
    currency: string;
    payer_currency: string;
  };
} & (
  | {
      trade_state: 'SUCCESS';
      /**
       * 自定义数据，使用前请先判断 trade_state === 'SUCCESS'
       */
      attach: Attach;
    }
  | {
      /**
   * 交易状态，枚举值：
    - SUCCESS：支付成功
    - REFUND：转入退款
    - NOTPAY：未支付
    - CLOSED：已关闭
    - REVOKED：已撤销（付款码支付）
    - USERPAYING：用户支付中（付款码支付）
    - PAYERROR：支付失败(其他原因，如银行返回失败)
   */
      trade_state: 'REFUND' | 'NOTPAY' | 'CLOSED' | 'REVOKED' | 'USERPAYING' | 'PAYERROR';
    }
);
