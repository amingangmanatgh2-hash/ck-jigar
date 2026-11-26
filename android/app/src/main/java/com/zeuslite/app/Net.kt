package com.zeuslite.app

import android.content.Context
import android.net.Uri
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * One configuration the user added: everything a client needs, read out of a `vless://` (or `trojan://`) link.
 *
 * The link itself is kept as it was given, because that is what gets sent to the core, exported and shown as a
 * QR code — nothing is re-serialised and lost on the way.
 */
data class Profile(
    val id: String,
    val name: String,
    val link: String,
    val protocol: String,
    val uuid: String,
    val host: String,
    val port: Int,
    val path: String,
    val wsHost: String,
    val sni: String,
    val tls: Boolean,
    val fp: String,
    val alpn: String,
    val flow: String,
    val network: String,
) {
    /** `host:port`, for a card subtitle. */
    val endpoint: String get() = "$host:$port"

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("link", link)
        put("protocol", protocol)
        put("uuid", uuid)
        put("host", host)
        put("port", port)
        put("path", path)
        put("wsHost", wsHost)
        put("sni", sni)
        put("tls", tls)
        put("fp", fp)
        put("alpn", alpn)
        put("flow", flow)
        put("network", network)
    }

    companion object {
        fun fromJson(json: JSONObject) = Profile(
            id = json.optString("id", UUID.randomUUID().toString()),
            name = json.optString("name", "config"),
            link = json.optString("link", ""),
            protocol = json.optString("protocol", "vless"),
            uuid = json.optString("uuid", ""),
            host = json.optString("host", ""),
            port = json.optInt("port", 443),
            path = json.optString("path", "/"),
            wsHost = json.optString("wsHost", ""),
            sni = json.optString("sni", ""),
            tls = json.optBoolean("tls", true),
            fp = json.optString("fp", ""),
            alpn = json.optString("alpn", ""),
            flow = json.optString("flow", ""),
            network = json.optString("network", "ws"),
        )
    }
}

/** Reading links, fetching subscriptions and keeping the list on the device. */
object Links {

    /** Read a shareable link. Returns null when it is not one this app can run. */
    fun parse(raw: String): Profile? {
        val text = raw.trim()
        val uri = runCatching { Uri.parse(text) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "vless" && scheme != "trojan") return null

        val host = uri.host ?: return null
        val port = if (uri.port > 0) uri.port else 443
        val uuid = uri.userInfo ?: return null
        val tls = when (uri.getQueryParameter("security")?.lowercase()) {
            "none" -> false
            "tls", "reality" -> true
            else -> true
        }
        val name = uri.fragment?.let { runCatching { Uri.decode(it) }.getOrNull() }?.takeIf { it.isNotBlank() }
            ?: "$host:$port"
        return Profile(
            id = UUID.randomUUID().toString(),
            name = name.take(60),
            link = text,
            protocol = scheme,
            uuid = uuid,
            host = host,
            port = port,
            path = uri.getQueryParameter("path") ?: "/",
            wsHost = uri.getQueryParameter("host") ?: host,
            sni = uri.getQueryParameter("sni") ?: uri.getQueryParameter("host") ?: host,
            tls = tls,
            fp = uri.getQueryParameter("fp") ?: "",
            alpn = uri.getQueryParameter("alpn") ?: "",
            flow = uri.getQueryParameter("flow") ?: "",
            network = uri.getQueryParameter("type") ?: "tcp",
        )
    }

    /** Every link in a blob of text — one per line, or a base64 subscription document. */
    fun parseMany(body: String): List<Profile> {
        val text = unwrapBase64(body.trim())
        return text.lineSequence()
            .map { it.trim() }
            .filter { it.startsWith("vless://", true) || it.startsWith("trojan://", true) }
            .mapNotNull { parse(it) }
            .toList()
    }

    /** A subscription is usually base64 of the link list; some providers send plain text. */
    fun unwrapBase64(body: String): String {
        val looksBase64 = body.isNotEmpty() && body.none { it == ':' || it == '\n' || it == ' ' } && body.length > 16
        if (!looksBase64) return body
        return runCatching {
            val padded = body + "=".repeat((4 - body.length % 4) % 4)
            String(Base64.decode(padded, Base64.DEFAULT), Charsets.UTF_8)
        }.getOrDefault(body)
    }

    /** Download a subscription. Throws with a message the UI can show. */
    fun fetch(url: String): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 20_000
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", "ZeusLite/1.0")
            setRequestProperty("Accept", "*/*")
        }
        try {
            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code")
            return connection.inputStream.bufferedReader().use(BufferedReader::readText)
        } finally {
            connection.disconnect()
        }
    }
}

/** The list, kept in shared preferences as one JSON array: small, synchronous, and enough. */
object Store {
    private const val FILE = "zeus_lite"
    private const val KEY_PROFILES = "profiles"
    private const val KEY_SUB = "subscription"
    private const val KEY_LANG = "lang"

    private fun prefs(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun load(context: Context): List<Profile> {
        val raw = prefs(context).getString(KEY_PROFILES, "[]") ?: "[]"
        return runCatching {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { index ->
                array.optJSONObject(index)?.let { Profile.fromJson(it) }
            }
        }.getOrDefault(emptyList())
    }

    fun save(context: Context, profiles: List<Profile>) {
        val array = JSONArray()
        profiles.forEach { array.put(it.toJson()) }
        prefs(context).edit().putString(KEY_PROFILES, array.toString()).apply()
    }

    /** Add or replace by id; returns the new list. */
    fun add(context: Context, profile: Profile): List<Profile> {
        val next = load(context).toMutableList()
        val existing = next.indexOfFirst { it.link == profile.link }
        if (existing >= 0) next[existing] = profile.copy(id = next[existing].id) else next.add(0, profile)
        save(context, next)
        return next
    }

    fun remove(context: Context, id: String): List<Profile> {
        val next = load(context).filterNot { it.id == id }
        save(context, next)
        return next
    }

    fun subscription(context: Context): String = prefs(context).getString(KEY_SUB, "") ?: ""
    fun setSubscription(context: Context, url: String) {
        prefs(context).edit().putString(KEY_SUB, url).apply()
    }

    fun lang(context: Context): String = prefs(context).getString(KEY_LANG, "fa") ?: "fa"
    fun setLang(context: Context, lang: String) {
        prefs(context).edit().putString(KEY_LANG, lang).apply()
    }
}
