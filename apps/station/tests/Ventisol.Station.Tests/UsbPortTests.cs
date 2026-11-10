using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class UsbPortTests
{
    // As Windows listed them for an LI3678 cradle in CDC mode, on port 4 of a hub on root port 7.
    const string Pci = "PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(7)#USB(4)";
    const string Acpi = "ACPI(_SB_)#ACPI(PC00)#ACPI(XHCI)#ACPI(RHUB)#ACPI(HS07)#USB(4)";

    [Fact]
    public void Picks_the_PCI_path_through_the_root_hub()
    {
        Assert.Equal(Pci, UsbPort.PickLocationPath([Acpi, Pci]));
        Assert.Equal(Pci, UsbPort.PickLocationPath([Pci, Acpi, ""]));
    }

    [Fact]
    public void Picks_another_path_if_there_is_no_PCI_one()
    {
        Assert.Equal(Acpi, UsbPort.PickLocationPath([null, " ", Acpi]));
    }

    [Fact]
    public void Skips_the_path_of_an_interface()
    {
        Assert.Equal("PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(12)",
            UsbPort.PickLocationPath(["PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(12)#USBMI(0)", "PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(12)"]));
    }

    [Fact]
    public void Picks_nothing_from_nothing()
    {
        Assert.Null(UsbPort.PickLocationPath(null));
        Assert.Null(UsbPort.PickLocationPath([]));
        Assert.Null(UsbPort.PickLocationPath(["", null]));
    }

    [Fact]
    public void Builds_the_id_from_the_path()
    {
        Assert.Equal("usb:" + Pci, UsbPort.IdOf(" " + Pci + " "));
        Assert.True(UsbPort.IsPortId("usb:" + Pci));
        Assert.True(UsbPort.IsPortId("USB:" + Pci));
    }

    [Theory]
    [InlineData("usb:" + Pci, "7.4")]
    [InlineData("usb:PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(3)", "3")]
    [InlineData("usb:PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(22)#USB(1)#USB(7)", "22.1.7")]
    [InlineData("usb:" + Acpi, "4")]
    [InlineData("usb:PCIROOT(0)#PCI(1400)#USBROOT(0)", null)]
    [InlineData("USB_CDC_SYMBOL_SCANNER", null)]
    [InlineData("keyboard", null)]
    [InlineData(null, null)]
    public void Reads_the_port_numbers(string? id, string? expected)
    {
        Assert.Equal(expected, UsbPort.PortNumbers(id));
    }

    [Fact]
    public void Labels_a_port_with_its_COM_port()
    {
        Assert.Equal("USB-port 7.4 (COM3)", UsbPort.Label("usb:" + Pci, "COM3"));
        Assert.Equal("USB-port 7.4", UsbPort.Label("usb:" + Pci));
        Assert.Equal("USB-port 7.4", UsbPort.Label("usb:" + Pci, " "));
    }

    [Fact]
    public void Labels_an_old_serial_as_itself()
    {
        Assert.Equal("USB_CDC_SYMBOL_SCANNER", UsbPort.Label("USB_CDC_SYMBOL_SCANNER"));
        Assert.Equal("S20123456789 (COM5)", UsbPort.Label("S20123456789", "COM5"));
        Assert.Equal("PCIROOT(0)", UsbPort.Label("usb:PCIROOT(0)"));
    }
}
