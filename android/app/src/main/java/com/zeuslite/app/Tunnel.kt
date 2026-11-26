package com.zeuslite.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.lang.reflect.Proxy

/** What the UI shows about the tunnel. The service owns it; Compose observes it. */
object TunnelState {
    var connected by mutableStateOf(false)
    var busy by mutableStateOf(false)
    var message by mutableStateOf("")
    var since by mutableStateOf(0L)
    var activeName by mutableStateOf("")
}

/** The Xray configuration the core runs: one socks inbound, one outbound, and DNS that never needs UDP. */
object XrayConfig {

    const val SOCKS_PORT = 10808

    fun build(profile: Profile): String {
        val outbound = JSONObject().apply {
            put("tag", "proxy")
            put("protocol", profile.protocol)
            if (profile.protocol == "trojan") {
                put("settings", JSONObject().apply {
                    put("servers", JSONArray().put(JSONObject().apply {
                        put("address", profile.host)
                        put("port", profile.port)
                        put("password", profile.uuid)
                    }))
                })
            } else {
                put("settings", JSONObject().apply {
                    put("vnext", JSONArray().put(JSONObject().apply {
                        put("address", profile.host)
                        put("port", profile.port)
                        put("users", JSONArray().put(JSONObject().apply {
                            put("id", profile.uuid)
                            put("encryption", "none")
                            put("flow", profile.flow)
                        }))
                    }))
                })
            }

            val tls = JSONObject().apply {
                put("serverName", profile.sni.ifBlank { profile.host })
                put("allowInsecure", false)
                if (profile.fp.isNotBlank()) put("fingerprint", profile.fp)
                if (profile.alpn.isNotBlank()) {
                    put("alpn", JSONArray(profile.alpn.split(',').map { it.trim() }.filter { it.isNotEmpty() }))
                }
            }

            put("streamSettings", JSONObject().apply {
                put("network", profile.network.ifBlank { "tcp" })
                put("security", if (profile.tls) "tls" else "none")
                if (profile.tls) put("tlsSettings", tls)
                if ((profile.network.ifBlank { "tcp" }) == "ws") {
                    put("wsSettings", JSONObject().apply {
                        put("path", profile.path.ifBlank { "/" })
                        put("headers", JSONObject().put("Host", profile.wsHost.ifBlank { profile.host }))
                    })
                }
            })
        }

        val dns = JSONObject().apply {
            // A Worker can only relay TCP, so names are resolved over HTTPS, which is TCP.
            put("servers", JSONArray(listOf("https://1.1.1.1/dns-query", "https://dns.google/dns-query")))
            put("queryStrategy", "UseIPv4")
        }

        val routing = JSONObject().apply {
            put("domainStrategy", "IPIfNonMatch")
            put("rules", JSONArray().apply {
                put(JSONObject().put("type", "field").put("port", 53).put("outboundTag", "dns-out"))
                put(JSONObject().put("type", "field").put("ip", JSONArray(listOf(
                    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"
                ))).put("outboundTag", "direct"))
            })
        }

        val config = JSONObject().apply {
            put("log", JSONObject().put("loglevel", "warning"))
            put("dns", dns)
            put("inbounds", JSONArray().put(JSONObject().apply {
                put("tag", "socks")
                put("listen", "127.0.0.1")
                put("port", SOCKS_PORT)
                put("protocol", "socks")
                put("settings", JSONObject().put("auth", "noauth").put("udp", true))
                // tun2socks speaks to this inbound; the sniffer keeps host names intact for routing
                put("sniffing", JSONObject().put("enabled", true).put("destOverride", JSONArray(listOf("http", "tls"))))
            }))
            put("outbounds", JSONArray(listOf(
                outbound,
                JSONObject().put("tag", "direct").put("protocol", "freedom"),
                JSONObject().put("tag", "block").put("protocol", "blackhole"),
                JSONObject().put("tag", "dns-out").put("protocol", "dns"),
            )))
            put("routing", routing)
        }
        return config.toString()
    }
}

/**
 * The bridge to `libv2ray` (AndroidLibXrayLite, the Xray core v2rayNG uses), done through reflection.
 *
 * Reflection because the library's generated Java API is a moving target between releases: a missing method
 * shows up as a message in the app instead of a build that never compiled. The names used here are the ones
 * every release of AndroidLibXrayLite has had for years: `Libv2ray.newV2RayPoint(supportSet, adns)`,
 * `V2RayPoint.configureFileContent`, `runLoop()` and `stopLoop()`.
 */
class CoreBridge(private val service: ZeusVpnService) {

    private val libClass: Class<*> = Class.forName("libv2ray.Libv2ray")
    var point: Any? = null
        private set
    private var pointClass: Class<*>? = null
    private var tun: ParcelFileDescriptor? = null

    /** Build the point with a callback proxy and hand it the configuration. */
    fun create(config: String): Any {
        val factory = libClass.methods.firstOrNull { it.name == "newV2RayPoint" && it.parameterTypes.size == 2 }
            ?: throw IllegalStateException("libv2ray.newV2RayPoint is missing from this build of the core")
        val iface = factory.parameterTypes[0]
        val callback = Proxy.newProxyInstance(iface.classLoader ?: javaClass.classLoader, arrayOf(iface)) { _, method, args ->
            onCallback(method, args ?: emptyArray())
        }
        val created = factory.invoke(null, callback, false)
            ?: throw IllegalStateException("the core refused to start")
        point = created
        pointClass = created.javaClass
        setField("configureFileContent", config)
        setField("domainName", "127.0.0.1")
        setField("packageName", service.packageName)
        return created
    }

    fun run() = call("runLoop")

    fun stop() {
        runCatching { call("stopLoop") }
        closeTun()
    }

    /** Fields are optional: an older or newer core may not have them, and that is not an error. */
    private fun setField(name: String, value: Any) {
        runCatching {
            val field = pointClass?.getField(name) ?: return@runCatching
            field.set(point, value)
        }
    }

    private fun call(name: String) {
        val method = pointClass?.methods?.firstOrNull { it.name == name && it.parameterTypes.isEmpty() }
            ?: throw IllegalStateException("the core has no $name()")
        method.invoke(point)
    }

    /**
     * The callbacks the core makes into the app: it asks the app to build the tunnel (`Setup`), to prepare
     * (`Prepare`), to let a socket bypass the tunnel (`Protect`), and to stop (`Shutdown`).
     */
    private fun onCallback(method: java.lang.reflect.Method, args: Array<Any?>): Any? {
        when (method.name.lowercase()) {
            "setup" -> {
                val established = establishTunnel()
                if (!established) {
                    TunnelState.connected = false
                    TunnelState.message = TunnelState.message.ifBlank { "could not create the VPN interface" }
                }
            }
            "protect" -> {
                val fd = (args.firstOrNull() as? Number)?.toInt()
                val allowed = fd != null && service.protectFd(fd)
                // gomobile sometimes generates boolean, sometimes long, for the same call
                return if (method.returnType == java.lang.Boolean.TYPE) allowed else if (allowed) 1L else 0L
            }
            "shutdown" -> service.onCoreStopped()
            else -> Unit
        }
        // The interface's returns are primitives; null would crash the call into the core.
        return when (method.returnType) {
            java.lang.Boolean.TYPE -> false
            java.lang.Long.TYPE -> 0L
            java.lang.Integer.TYPE -> 0
            java.lang.Double.TYPE -> 0.0
            java.lang.Float.TYPE -> 0f
            java.lang.Short.TYPE -> 0.toShort()
            java.lang.Byte.TYPE -> 0.toByte()
            java.lang.Character.TYPE -> '\u0000'
            else -> null
        }
    }

    private fun establishTunnel(): Boolean {
        if (tun != null) return true
        return try {
            val builder = service.newBuilder()
                .setSession("Zeus Lite")
                .setMtu(1500)
                .addAddress("10.66.7.2", 32)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("1.1.1.1")
                .addDnsServer("8.8.8.8")
            runCatching {
                builder.addAddress("fd00:66:7::2", 128)
                builder.addRoute("::", 0)
            }
            tun = builder.establish()
            tun != null
        } catch (err: Throwable) {
            TunnelState.message = err.message ?: "VPN setup failed"
            false
        }
    }

    private fun closeTun() {
        runCatching { tun?.close() }
        tun = null
    }
}

/** The VPN itself: a foreground service that owns the core and the tunnel. */
class ZeusVpnService : VpnService() {

    companion object {
        const val ACTION_START = "com.zeuslite.app.START"
        const val ACTION_STOP = "com.zeuslite.app.STOP"
        const val EXTRA_LINK = "link"
        private const val EXTRA_NAME = "name"
        private const val CHANNEL = "zeus_tunnel"
        private const val NOTIFICATION_ID = 7

        fun start(context: Context, link: String, name: String) {
            val intent = Intent(context, ZeusVpnService::class.java)
                .setAction(ACTION_START)
                .putExtra(EXTRA_LINK, link)
                .putExtra(EXTRA_NAME, name)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, ZeusVpnService::class.java).setAction(ACTION_STOP))
            TunnelState.busy = false
        }
    }

    private var bridge: CoreBridge? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startTunnel(intent.getStringExtra(EXTRA_LINK).orEmpty(), intent.getStringExtra(EXTRA_NAME).orEmpty())
            ACTION_STOP -> shutdown()
            else -> Unit
        }
        return START_NOT_STICKY
    }

    private fun startTunnel(link: String, name: String) {
        if (TunnelState.connected) shutdown()
        TunnelState.busy = true
        TunnelState.message = ""
        startForegroundSafely("connecting…")
        Thread {
            try {
                val profile = Links.parse(link) ?: throw IllegalArgumentException("this link cannot be used")
                val config = XrayConfig.build(profile)
                val core = CoreBridge(this)
                bridge = core
                core.create(config)
                core.run()
                TunnelState.activeName = name.ifBlank { profile.name }
                TunnelState.since = System.currentTimeMillis()
                TunnelState.connected = true
                TunnelState.busy = false
                notify("connected")
            } catch (err: Throwable) {
                TunnelState.connected = false
                TunnelState.busy = false
                TunnelState.message = err.message ?: err.javaClass.simpleName
                shutdown()
            }
        }.start()
    }

    private fun shutdown() {
        runCatching { bridge?.stop() }
        bridge = null
        TunnelState.connected = false
        TunnelState.busy = false
        TunnelState.since = 0
        TunnelState.activeName = ""
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }

    fun onCoreStopped() {
        TunnelState.connected = false
        TunnelState.message = "the core stopped"
    }

    fun protectFd(fd: Int): Boolean = runCatching { protect(fd) }.getOrDefault(false)

    fun newBuilder(): Builder = Builder()

    private fun startForegroundSafely(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Tunnel", NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                },
            )
        }
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun notify(text: String) {
        runCatching {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text))
        }
    }

    private fun buildNotification(text: String): android.app.Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Zeus Lite")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
