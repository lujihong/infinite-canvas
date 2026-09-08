"use client";

import { Modal, Typography } from "antd";

export type LegalDocType = "agreement" | "privacy" | null;

type LegalModalProps = {
    type: LegalDocType;
    open: boolean;
    onClose: () => void;
};

export function LegalModal({ type, open, onClose }: LegalModalProps) {
    const isAgreement = type === "agreement";
    const title = isAgreement ? "鑫元宝视频创作工作台用户服务协议" : "鑫元宝视频创作工作台隐私政策";

    return (
        <Modal
            open={open}
            title={<span className="text-base font-bold text-stone-900 dark:text-stone-100">{title}</span>}
            onCancel={onClose}
            footer={null}
            centered
            width={680}
            destroyOnClose
            styles={{
                body: {
                    maxHeight: "70vh",
                    overflowY: "auto",
                    paddingRight: "8px",
                },
            }}
        >
            <div className="text-xs leading-relaxed text-stone-700 dark:text-stone-300 space-y-4 pt-2">
                {isAgreement ? (
                    <>
                        <div className="rounded-lg bg-stone-100 p-3 dark:bg-stone-800/60 text-[11px] text-stone-500 dark:text-stone-400">
                            <p><strong>生效日期：</strong>2026年08月31日</p>
                            <p><strong>运营主体：</strong>鑫元宝云计算（重庆）有限责任公司</p>
                            <p><strong>服务平台：</strong>鑫元宝视频创作工作台（www.xybcloud.com）及关联模型中转系统（api.xybcloud.com）</p>
                        </div>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">一、 总则与协议范围</h4>
                            <p>1. 本《用户服务协议》（以下简称“本协议”）是由<strong>鑫元宝云计算（重庆）有限责任公司</strong>（以下简称“本公司”或“我们”）与鑫元宝视频创作工作台（以下简称“本工作台”或“平台”）的使用者（以下简称“用户”或“您”）所订立的具有法律效力的协议。</p>
                            <p>2. 在您注册、登录、使用画布创作或调用 AI 生成能力前，请务必审慎阅读并充分理解本协议。当您勾选“同意”或实际使用本服务时，即视为您已完整阅读并自愿接受本协议及《隐私政策》的全部约束。</p>
                        </section>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">二、 账号与生态互通规范</h4>
                            <p>1. <strong>账号互通：</strong>本工作台与鑫元宝云计算模型服务平台（api.xybcloud.com）实行统一身份通行认证。您在工作台注册的账号将自动开通模型云底座访问凭据并分配专属安全令牌。</p>
                            <p>2. <strong>账号保管：</strong>您有义务妥善保管您的登录名、电子邮箱、登录密码及专属令牌。凡使用您账号进行的所有操作（包括但不限于画布创建、媒体文件上传、模型生成与充值消费），均视为您本人的真实行为并由您承担相应法律责任。</p>
                        </section>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">三、 AI 生成服务与内容合规准则</h4>
                            <p>1. 本平台为您提供基于生成式人工智能的文本辅助、图像生成、视频编导渲染、音频合成与多媒体画布工作流调度服务。</p>
                            <p>2. <strong>合规红线：</strong>您承诺在使用本平台服务过程中，严格遵守《中华人民共和国网络安全法》《生成式人工智能服务管理暂行条例》及相关法律法规，<strong>严禁利用本服务制作、复制、发布、传播以下内容：</strong></p>
                            <ul className="list-disc pl-5 space-y-1 text-stone-600 dark:text-stone-400">
                                <li>反对宪法确定的基本原则，危害国家安全、破坏国家统一的；</li>
                                <li>煽动民族仇恨、民族歧视，破坏民族团结的；</li>
                                <li>散布淫秽、色情、赌博、暴力、凶杀、恐怖或者教唆犯罪的；</li>
                                <li>侮辱或者诽谤他人，侵害他人名誉权、肖像权、隐私权、知识产权及其他合法权益的；</li>
                                <li>利用深度合成技术伪造未经授权的他人肖像、音色或虚假新闻信息危害公共利益的。</li>
                            </ul>
                            <p>3. 若您的请求触发敏感词过滤或安全风控机制，系统将依法实施自动拦截，并保留相关调用日志向监管机构报告的权利。</p>
                        </section>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">四、 资费计量、充值与消费规则</h4>
                            <p>1. 本平台采用预付费算力额度计量机制。每次执行文生图、图生图、视频生成、声音克隆或文本润色，系统将根据上游各模型对应费率扣除相应算力额度。</p>
                            <p>2. <strong>充值与到账：</strong>用户可通过微信官方支付等渠道进行在线充值，充值成功后算力额度将实时同步至您的账户，支持在创作工作台与模型服务中转站跨端通用。</p>
                            <p>3. <strong>消费退款说明：</strong>鉴于数字算力资源具有实时消耗性，一旦模型推理任务开始执行，相应扣除的算力额度原则上不予退还；如遇因系统故障导致的生成任务未产出异常，经技术审计后可自动补偿。</p>
                        </section>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">五、 知识产权与成果归属</h4>
                            <p>1. 本工作台的所有界面设计、画布架构、代码逻辑、商标与知识产权归属于<strong>鑫元宝云计算（重庆）有限责任公司</strong>。</p>
                            <p>2. 在您合法、合规使用本服务的前提下，您通过本平台画布及 AI 工具创作生成的作品，其知识产权由您依据国家法律法规享有并自行负责。</p>
                        </section>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">六、 争议管辖与法律适用</h4>
                            <p>本协议之效力、解释、变更、执行与争议解决均适用中华人民共和国法律。因本协议产生之争议，双方应友好协商；协商不成的，应提交<strong>鑫元宝云计算（重庆）有限责任公司住所地有管辖权的人民法院（重庆市渝中区人民法院）</strong>诉讼解决。</p>
                        </section>
                    </>
                ) : (
                    <>
                        <div className="rounded-lg bg-stone-100 p-3 dark:bg-stone-800/60 text-[11px] text-stone-500 dark:text-stone-400">
                            <p><strong>生效日期：</strong>2026年08月31日</p>
                            <p><strong>数据控制方：</strong>鑫元宝云计算（重庆）有限责任公司</p>
                            <p><strong>保护原则：</strong>合法、正当、必要、诚信、数据最小化与金融级加密防护</p>
                        </div>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">一、 我们如何收集和使用您的信息</h4>
                            <p>1. <strong>账号与登录信息：</strong>在您注册时，我们需要收集您的<strong>用户名、电子邮箱地址、设置的加密密码</strong>，以完成身份核验与账户创建。</p>
                            <p>2. <strong>创作与存储数据：</strong>当您在工作台进行创作时，系统会在您的专属加密数据库中持久化保存您的<strong>画布节点、连线关系、提示词内容、项目元数据及生成的素材成果</strong>，确保您在多设备间登录时数据完整无损。</p>
                            <p>3. <strong>充值支付信息：</strong>在您发起算力充值时，系统会记录<strong>订单交易流水号、充值金额、支付渠道与支付时间戳</strong>。我们不收集、不存储您的银行卡密码或支付安全密码。</p>
                            <p>4. <strong>服务日志信息：</strong>为保障平台运营安全与风控审计，系统会按法律法规记录操作时间戳、请求 IP 与接口调用状态。</p>
                        </section>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">二、 数据安全与存储保障</h4>
                            <p>1. <strong>存储地点：</strong>我们在中国境内收集的个人信息与业务数据，均存储于中华人民共和国境内的高安全性云服务器与企业加密数据库中。</p>
                            <p>2. <strong>安全防护机制：</strong>全站采用 TLS 1.3 / HTTPS 高强度加密传输，数据库密码采用单向高强度加盐哈希，平台实行租户级数据隔离，严格杜绝未授权访问。</p>
                            <p>3. <strong>内容安全承诺：</strong>除为履行模型生成所必须向上游计算引擎加密传输输入提示词外，<strong>我们绝不将您的私有提示词、参考图像或创作成果用于模型公开训练或商业出售</strong>。</p>
                        </section>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">三、 您的数据权利与账号管理</h4>
                            <p>您对您的个人信息和创作数据享有充分的自主权利，包括查阅个人资料、随时重命名或删除您的画布项目、清空生成历史记录或重置登录密码。如需注销账号，可联系官方团队协助办理，注销后相关数据将按法规要求安全清除。</p>
                        </section>

                        <section>
                            <h4 className="font-semibold text-stone-900 dark:text-stone-100 mb-1">四、 联系方式</h4>
                            <p>如您对本隐私政策有任何疑问或建议，欢迎联系：</p>
                            <p className="text-stone-500 dark:text-stone-400">
                                鑫元宝云计算（重庆）有限责任公司<br />
                                办公地址：重庆市渝中区石油路街道大坪正街 160 号 3 幢 37-1#<br />
                                官方服务：https://www.xybcloud.com / https://api.xybcloud.com
                            </p>
                        </section>
                    </>
                )}
            </div>
        </Modal>
    );
}
