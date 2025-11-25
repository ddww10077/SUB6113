/**
 * 订阅请求处理模块
 * 处理MiSub订阅请求的主要逻辑
 */

import { StorageFactory } from '../storage-adapter.js';
import { migrateConfigSettings, formatBytes, getCallbackToken } from './utils.js';
import { generateCombinedNodeList, defaultSettings } from './subscription.js';
import { sendEnhancedTgNotification } from './notifications.js';

// 常量定义
const KV_KEY_SUBS = 'misub_subscriptions_v1';
const KV_KEY_PROFILES = 'misub_profiles_v1';
const KV_KEY_SETTINGS = 'worker_settings_v1';

/**
 * -------------------------------
 * ✅ 你的自定义 3 个过期 SS 节点（不会被过滤）
 * -------------------------------
 */
const EXPIRED_NODES = [
    "ss://YWVzLTI1Ni1nY206MDAwMDAwMDAwMDAwMDAwMA==@127.0.0.1:443#🇨🇳 订阅会员已到期",
    "ss://YWVzLTI1Ni1nY206MDAwMDAwMDAwMDAwMDAwMA==@127.0.0.1:443#🇨🇳 订阅会员已到期",
    "ss://YWVzLTI1Ni1nY206MDAwMDAwMDAwMDAwMDAwMA==@127.0.0.1:443#🇨🇳 请联系客服续费",
    "ss://YWVzLTI1Ni1nY206MDAwMDAwMDAwMDAwMDAwMA==@127.0.0.1:443#🇨🇳 微信 EX3116"
];

/**
 * 处理MiSub订阅请求
 * @param {Object} context - Cloudflare上下文
 * @returns {Promise<Response>} HTTP响应
 */
export async function handleMisubRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const userAgentHeader = request.headers.get('User-Agent') || "Unknown";

    const storageAdapter = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
    const [settingsData, misubsData, profilesData] = await Promise.all([
        storageAdapter.get(KV_KEY_SETTINGS),
        storageAdapter.get(KV_KEY_SUBS),
        storageAdapter.get(KV_KEY_PROFILES)
    ]);
    const settings = settingsData || {};
    const allMisubs = misubsData || [];
    const allProfiles = profilesData || [];

    const config = migrateConfigSettings({ ...defaultSettings, ...settings });

    let token = '';
    let profileIdentifier = null;
    const pathSegments = url.pathname.replace(/^\/sub\//, '/').split('/').filter(Boolean);

    if (pathSegments.length > 0) {
        token = pathSegments[0];
        if (pathSegments.length > 1) {
            profileIdentifier = pathSegments[1];
        }
    } else {
        token = url.searchParams.get('token');
    }

    let targetMisubs;
    let subName = config.FileName;
    let effectiveSubConverter;
    let effectiveSubConfig;
    let isProfileExpired = false;

    if (profileIdentifier) {

        if (!token || token !== config.profileToken) {
            return new Response('Invalid Profile Token', { status: 403 });
        }

        const profile = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);

        if (!profile || !profile.enabled) {
            return new Response('Profile not found or disabled', { status: 404 });
        }

        if (profile.expiresAt) {
            const expiryDate = new Date(profile.expiresAt);
            const now = new Date();
            if (now > expiryDate) {
                isProfileExpired = true;
            }
        }

        if (isProfileExpired) {
            subName = profile.name;

            /**
             * -----------------------------------
             * ✅ 过期 → 返回 3 个自定义 SS 节点
             * -----------------------------------
             */
            targetMisubs = EXPIRED_NODES.map((node, index) => ({
                id: `expired-node-${index}`,
                url: node,
                name: "订阅已到期",
                isExpiredNode: true
            }));

        } else {
            subName = profile.name;
            const profileSubIds = new Set(profile.subscriptions);
            const profileNodeIds = new Set(profile.manualNodes);

            targetMisubs = allMisubs.filter(item => {
                const isSubscription = item.url.startsWith('http');
                const isManualNode = !isSubscription;

                const belongsToProfile =
                    (isSubscription && profileSubIds.has(item.id)) ||
                    (isManualNode && profileNodeIds.has(item.id));

                return item.enabled && belongsToProfile;
            });
        }

        effectiveSubConverter =
            profile.subConverter?.trim() !== '' ? profile.subConverter : config.subConverter;
        effectiveSubConfig =
            profile.subConfig?.trim() !== '' ? profile.subConfig : config.subConfig;

    } else {

        if (!token || token !== config.mytoken) {
            return new Response('Invalid Token', { status: 403 });
        }

        targetMisubs = allMisubs.filter(s => s.enabled);
        effectiveSubConverter = config.subConverter;
        effectiveSubConfig = config.subConfig;
    }

    if (!effectiveSubConverter || effectiveSubConverter.trim() === '') {
        return new Response('Subconverter backend is not configured.', { status: 500 });
    }

    /**
     * -------- 处理 target format --------
     */
    let targetFormat = url.searchParams.get('target');
    if (!targetFormat) {
        const supportedFormats = ['clash', 'singbox', 'surge', 'loon', 'base64', 'v2ray', 'trojan'];
        for (const format of supportedFormats) {
            if (url.searchParams.has(format)) {
                targetFormat = (format === 'v2ray' || format === 'trojan') ? 'base64' : format;
                break;
            }
        }
    }

    if (!targetFormat) {
        const ua = userAgentHeader.toLowerCase();
        const uaMapping = [
            ['flyclash', 'clash'],
            ['mihomo', 'clash'],
            ['clash.meta', 'clash'],
            ['clash-verge', 'clash'],
            ['meta', 'clash'],
            ['stash', 'clash'],
            ['nekoray', 'clash'],
            ['sing-box', 'singbox'],
            ['shadowrocket', 'base64'],
            ['v2rayn', 'base64'],
            ['v2rayng', 'base64'],
            ['surge', 'surge'],
            ['loon', 'loon'],
            ['quantumult%20x', 'quanx'],
            ['quantumult', 'quanx'],
            ['clash', 'clash']
        ];

        for (const [keyword, format] of uaMapping) {
            if (ua.includes(keyword)) {
                targetFormat = format;
                break;
            }
        }
    }

    if (!targetFormat) targetFormat = 'base64';

    // TG 通知处理
    if (!url.searchParams.has('callback_token')) {
        const clientIp = request.headers.get('CF-Connecting-IP') || 'N/A';
        const country = request.headers.get('CF-IPCountry') || 'N/A';
        const domain = url.hostname;

        let additionalData = `*域名:* \`${domain}\`\n*客户端:* \`${userAgentHeader}\`\n*请求格式:* \`${targetFormat}\``;

        if (profileIdentifier) {
            additionalData += `\n*订阅组:* \`${subName}\``;
            const profile = allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier);
            if (profile && profile.expiresAt) {
                const expiryDateStr = new Date(profile.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                additionalData += `\n*到期时间:* \`${expiryDateStr}\``;
            }
        }

        context.waitUntil(sendEnhancedTgNotification(config, '🛰️ *订阅被访问*', clientIp, additionalData));
    }

    let prependedContentForSubconverter = '';

    if (isProfileExpired) {

        /**
         * -------------------------
         * 🟥 注意：过期不加入流量节点
         * -------------------------
         */
        prependedContentForSubconverter = '';

    } else {

        const totalRemainingBytes = targetMisubs.reduce((acc, sub) => {
            if (sub.enabled && sub.userInfo && sub.userInfo.total > 0) {
                const used = (sub.userInfo.upload || 0) + (sub.userInfo.download || 0);
                const remaining = sub.userInfo.total - used;
                return acc + Math.max(0, remaining);
            }
            return acc;
        }, 0);

        if (totalRemainingBytes > 0) {
            const formattedTraffic = formatBytes(totalRemainingBytes);
            const fakeNodeName = `流量剩余 ≫ ${formattedTraffic}`;
            prependedContentForSubconverter =
                `trojan://00000000-0000-0000-0000-000000000000@127.0.0.1:443#${encodeURIComponent(fakeNodeName)}`;
        }
    }

    const combinedNodeList = await generateCombinedNodeList(
        context,
        config,
        userAgentHeader,
        targetMisubs,
        prependedContentForSubconverter,
        profileIdentifier ? allProfiles.find(p => (p.customId && p.customId === profileIdentifier) || p.id === profileIdentifier)?.prefixSettings : null
    );

    /**
     * -------------------------
     * base64 输出
     * -------------------------
     */
    if (targetFormat === 'base64') {
        let contentToEncode;

        if (isProfileExpired) {
            /**
             * ------------------------------
             * 完整输出 3 个过期 SS 节点
             * ------------------------------
             */
            contentToEncode = EXPIRED_NODES.join("\n") + "\n";
        } else {
            contentToEncode = combinedNodeList;
        }

        const headers = {
            "Content-Type": "text/plain; charset=utf-8",
            'Cache-Control': 'no-store, no-cache'
        };
        return new Response(
            btoa(unescape(encodeURIComponent(contentToEncode))),
            { headers }
        );
    }

    /**
     * -------------------------
     * 非 base64 → Subconverter
     * -------------------------
     */

    const base64Content = btoa(unescape(encodeURIComponent(combinedNodeList)));

    const callbackToken = await getCallbackToken(env);
    const callbackPath = profileIdentifier
        ? `/${token}/${profileIdentifier}`
        : `/${token}`;
    const callbackUrl = `${url.protocol}//${url.host}${callbackPath}?target=base64&callback_token=${callbackToken}`;

    if (url.searchParams.get('callback_token') === callbackToken) {
        return new Response(base64Content, {
            headers: {
                "Content-Type": "text/plain; charset=utf-8",
                'Cache-Control': 'no-store, no-cache'
            }
        });
    }

    const subconverterUrl = new URL(`https://${effectiveSubConverter}/sub`);
    subconverterUrl.searchParams.set('target', targetFormat);
    subconverterUrl.searchParams.set('url', callbackUrl);

    if (
        (targetFormat === 'clash' || targetFormat === 'loon' || targetFormat === 'surge')
        && effectiveSubConfig?.trim() !== ''
    ) {
        subconverterUrl.searchParams.set('config', effectiveSubConfig);
    }

    subconverterUrl.searchParams.set('new_name', 'true');

    try {
        const subconverterResponse = await fetch(subconverterUrl.toString(), {
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (!subconverterResponse.ok) {
            const errorBody = await subconverterResponse.text();
            throw new Error(`Subconverter service returned status: ${subconverterResponse.status}. Body: ${errorBody}`);
        }

        const responseText = await subconverterResponse.text();

        const responseHeaders = new Headers(subconverterResponse.headers);
        responseHeaders.set(
            "Content-Disposition",
            `attachment; filename*=utf-8''${encodeURIComponent(subName)}`
        );
        responseHeaders.set('Content-Type', 'text/plain; charset=utf-8');
        responseHeaders.set('Cache-Control', 'no-store, no-cache');

        return new Response(responseText, {
            status: subconverterResponse.status,
            statusText: subconverterResponse.statusText,
            headers: responseHeaders
        });

    } catch (error) {
        console.error(`[MiSub Final Error] ${error.message}`);
        return new Response(`Error connecting to subconverter: ${error.message}`, {
            status: 502
        });
    }
}
