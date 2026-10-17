import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("tls_front_config", Path(__file__).with_name("tls-front-config.py"))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class EndpointTests(unittest.TestCase):
    def test_existing_bindings(self):
        for host, authority in [("0.0.0.0", "127.0.0.1"), ("192.168.1.20", "192.168.1.20"),
                                ("::", "[::1]"), ("::1", "[::1]"), ("localhost", "localhost")]:
            self.assertEqual(config.console_upstream({"ADMIN_BIND_HOST": host, "ADMIN_BIND_PORT": "8099"}), f"http://{authority}:8099")

    def test_compose_port_precedence(self):
        self.assertEqual(config.console_upstream({"ADMIN_WEB_PORT": "8100", "ADMIN_BIND_PORT": "8099"}), "http://127.0.0.1:8100")

    def test_invalid_authorities_and_ports(self):
        for host in ["user@host", "host/path", "host?query", "$(command)"]:
            with self.assertRaises(ValueError):
                config.console_upstream({"ADMIN_BIND_HOST": host})
        for port in ["0", "65536", "abc"]:
            with self.assertRaises(ValueError):
                config.console_upstream({"ADMIN_BIND_PORT": port})


if __name__ == "__main__":
    unittest.main()
