use std::net::IpAddr;

pub fn tailscale_ipv4() -> Option<String> {
    let ifaces = if_addrs::get_if_addrs().ok()?;
    for i in ifaces {
        if i.name == "tailscale0" && !i.is_loopback() {
            if let IpAddr::V4(v4) = i.ip() {
                return Some(v4.to_string());
            }
        }
    }
    None
}

pub fn lan_ipv4() -> Option<String> {
    let ifaces = if_addrs::get_if_addrs().ok()?;
    for i in ifaces {
        if i.name == "lo" || i.name == "tailscale0" || i.is_loopback() {
            continue;
        }
        if let IpAddr::V4(v4) = i.ip() {
            return Some(v4.to_string());
        }
    }
    None
}
